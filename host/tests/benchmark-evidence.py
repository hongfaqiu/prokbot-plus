"""Offline validator regressions. All deployment records are generated in memory, including the positive controls."""
from io import BytesIO
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from benchmark_checks import evidence, fixture, sha


class MemoryPath:
    """Only the directory and byte operations used by the public fixture and cohort reader."""
    def __init__(self, name='round'):
        self.name, self.children, self.data = name, {}, None

    def mkdir(self, **kwargs):
        pass

    def __truediv__(self, name):
        return self.children.setdefault(name, MemoryPath(name))

    def is_dir(self): return self.data is None
    def iterdir(self): return self.children.values()
    def write_bytes(self, data): self.data = data
    def write_text(self, data, encoding): self.data = data.encode(encoding)
    def read_bytes(self):
        if self.data is None: raise FileNotFoundError(self.name)
        return self.data

    def open(self, mode):
        assert mode == 'rb'
        return BytesIO(self.read_bytes())

    def glob(self, pattern):
        assert pattern == '*.jsonl'
        return [entry for entry in self.iterdir() if entry.name.endswith('.jsonl')]


def reviewed(change=None, **options):
    return evidence.inspect_run(fixture(MemoryPath(), synthetic=False, extra=True, mutate=change, **options))


class EvidenceTests(unittest.TestCase):
    def test_host_only_stays_diagnostic_even_with_all_successful_receipts(self):
        r = reviewed(mode='host-only')
        self.assertFalse(r['eligibleRound']); self.assertTrue(any('Host-only' in reason for reason in r['issues']))
        self.assertEqual(r['actions']['soak']['errors'], 0); self.assertIn('host', r['machines'])

    def test_measured_header_requires_a_vm_and_not_a_wsl_kernel(self):
        for change in ({'virt': 'systemd-nspawn'}, {'virt': 'unknown'}, {'kernel': 'linux-microsoft-standard-WSL2'}):
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'whole VM'):
                reviewed(lambda m, a, t: t['host'][0]['machine'].update(change))

    def test_zero_swap_uses_counter_deltas_not_lifetime_totals(self):
        for paging in ('swapInPages', 'swapOutPages', None):
            def no_swap(m, a, traces):
                for row in traces['host']:
                    if row['type'] == 'sample':
                        g = row['guest']; g.update(swapBytes=0, swapUsedBytes=0, swapInPages=17, swapOutPages=23)
                        if paging: g[paging] += row['seq']
            with self.subTest(paging=paging):
                r = reviewed(no_swap); g = r['machines']['host']['observation']['guest']
                self.assertEqual(r['eligibleRound'], paging is None, r['issues'])
                self.assertEqual(any('zero sampled swap' in s for s in r['issues']), paging is not None)
                self.assertEqual(g['swapInBytes'] > 0, paging == 'swapInPages')
                self.assertEqual(g['swapOutBytes'] > 0, paging == 'swapOutPages')

    def test_paired_controls_and_failed_deadlines(self):
        def load(after, skewed=False, timeout=False, changed=None):
            def edit(m, actions, traces):
                soak = [a for a in actions if a['phase'] == 'soak']
                for i, a in enumerate(soak):
                    first = (i == 0) if skewed else (i % 2 == 0)
                    a['client'] = ('after' if after else 'before') + ('1' if first else '2')
                # A retry is a separate attempt; the test cohorts have the same attempted plan.
                actions.append(dict(soak[0], id='retry', startMs=soak[0]['endMs'], endMs=soak[0]['endMs'] + 100,
                                    evidenceSha256=sha(m['runId'] + ':retry')))
                if timeout: soak[0]['ok'] = False
                if changed: m[changed] = sha('different-control')
            return edit

        def put(side, after, n=1, **options):
            fixture(side / str(n), synthetic=False, extra=True, after=after, number=n, mutate=load(after, **options))

        before, after = MemoryPath('before'), MemoryPath('after')
        for n in range(1, 4):
            put(before, False, n); put(after, True, n)
        matched = evidence.compare(before, after)
        self.assertTrue(matched['eligibleForReview'], matched['issues']); self.assertTrue(matched['deltas'])
        self.assertGreater(matched['rounds'][0]['before']['machines']['host']['observation']['guest']['swapOutBytes'], 0)
        for options, field in (({'skewed': True}, 'plan'), ({'changed': 'modelConfigSha256'}, 'controls'),
                               ({'changed': 'workloadSha256'}, 'controls')):
            put(after, True, **options)
            with self.subTest(options=options), self.assertRaisesRegex(ValueError, 'Mismatched before/after control: ' + field):
                evidence.compare(before, after)
        put(after, True, timeout=True)
        failed = evidence.compare(before, after)
        self.assertFalse(failed['eligibleForReview']); self.assertEqual(failed['deltas'], {})
        soak = failed['rounds'][0]['after']['actions']['soak']
        self.assertEqual((soak['attempts'], soak['errors'], soak['successfulChecks']['chat-reply']), (61, 1, 60))
        self.assertTrue(any('Failed operation: soak/chat-reply' in issue for issue in failed['issues']))


if __name__ == '__main__':
    unittest.main()
