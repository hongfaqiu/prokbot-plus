#!/usr/bin/env python3
"""ProkBot Plus benchmark observer and offline evidence validator (never generates workload)."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

import evidence
import guest


def selftest():
    # A deliberately short, synthetic, Host-only trace. Success means the validator *rejects* it as capacity evidence.
    with tempfile.TemporaryDirectory(prefix='prokbot-bench-selftest-') as temp:
        root = Path(temp); proc = root / 'proc'; proc.mkdir()
        (proc / 'meminfo').write_text('MemTotal: 128 kB\nMemAvailable: 64 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n', encoding='ascii')
        (proc / 'vmstat').write_text('oom_kill 0\npswpin 0\npswpout 0\n', encoding='ascii')
        header = {'type': 'header', 'schema': guest.SCHEMA, 'origin': 'synthetic', 'runId': 'selftest',
                  'mode': 'host-only', 'role': 'host', 'project': 'fixture', 'boot': 'a' * 64,
                  'intervalMs': 1000, 'durationMs': 2000,
                  'machine': {'key': 'b' * 64, 'arch': 'linux/amd64', 'virt': 'fixture', 'os': 'fixture',
                              'osVersion': '1', 'kernel': 'fixture', 'dockerVersion': 'fixture', 'tickHz': 100,
                              'pageBytes': 4096, 'disks': {'root': 'root', 'docker': 'root'}}}
        trace = [header]
        for seq in range(3):
            # Distinct guest ticks ensure the CPU calculation would fail if guest time were double-counted.
            (proc / 'stat').write_text(f'cpu  {10 + seq} 0 0 {40 + 3 * seq} 0 0 0 0 {4 + seq} 0\ncpu0 0\n', encoding='ascii')
            trace.append({'type': 'sample', 'seq': seq, 'monoMs': 1000 + 1000 * seq, 'atMs': 10000 + 1000 * seq,
                          'guest': guest.whole(proc, {'root': root}), 'services': {}})
        trace.append({'type': 'end', 'samples': 3, 'eventsComplete': True})
        data = ''.join(json.dumps(r) + '\n' for r in trace).encode(); (root / 'host.jsonl').write_bytes(data)
        (root / 'actions.jsonl').write_bytes(b'')
        manifest = {'schema': 1, 'mode': 'host-only', 'runId': 'selftest', 'revision': 'e' * 40, 'origin': 'synthetic',
                    'modelKind': 'mock', 'traceSha256': {'host': hashlib.sha256(data).hexdigest()},
                    'provisioned': {'host': {'vcpus': 1, 'ramBytes': 128 * 1024}},
                    'actionLogSha256': hashlib.sha256(b'').hexdigest(), 'phases': {},
                    **{field: 'c' * 64 for field in evidence.PREREQ}}
        (root / 'run.json').write_text(json.dumps(manifest), encoding='ascii')
        report = evidence.inspect_run(root)
        cpu = report['machines']['host']['observation']['guest']['cpu']['busyPct']['p95']
        guest.require(not report['eligibleRound'] and cpu == 25.0 and 'Synthetic guest capture: host' in report['issues'],
                      'Synthetic fixture did not fail closed')
    return {'selftest': 'passed', 'source': 'synthetic', 'capacityEvidence': False, 'liveRequests': 0}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sample = sub.add_parser('sample', help='Read local Linux VM metrics and write a new JSONL file (opt-in)')
    sample.add_argument('--isolated-guest', action='store_true', help='I am authorized to sample this dedicated non-production VM')
    sample.add_argument('--mode', choices=guest.MODES, required=True)
    sample.add_argument('--role', choices=('host', 'desktop'), required=True)
    sample.add_argument('--project', required=True, help='Exact local Compose project label; never enumerates other projects')
    sample.add_argument('--run-id', required=True, help='Unique public alias shared by the two roles of a split round')
    sample.add_argument('--out', type=Path, required=True, help='New trace file; existing files are never overwritten')
    sample.add_argument('--interval', type=int, default=5, help='Tick period, 1..30 seconds (default: 5)')
    sample.add_argument('--duration', type=int, required=True, help='Maximum observation window in seconds (up to 86400)')
    sample.add_argument('--disk', action='append', default=[], metavar='LABEL=/DIRECTORY',
                        help='Additional build/data filesystem; root and Docker data root always included')
    validate = sub.add_parser('validate', help='Inspect one directory containing run.json, actions.jsonl and guest trace(s)')
    validate.add_argument('round', type=Path)
    compare = sub.add_parser('compare', help='Compare all numbered round directories in both cohorts')
    for name in ('before', 'after'):
        compare.add_argument('--' + name, type=Path, required=True)
    for command in (validate, compare):
        command.add_argument('--evidence-dir', type=Path, help='Optionally rehash retained review artifacts named by receipt SHA-256')
    sub.add_parser('selftest', help='Offline synthetic smoke; does not contact Docker, a guest or a model')
    args = parser.parse_args(argv)
    if args.command == 'sample':
        guest.record(args)
        return 0
    if args.command == 'validate':
        result = evidence.inspect_run(args.round, args.evidence_dir); ok = result['eligibleRound']
    elif args.command == 'compare':
        result = evidence.compare(args.before, args.after, args.evidence_dir); ok = result['eligibleForReview']
    else:
        result, ok = selftest(), True
    print(json.dumps(result, indent=2, allow_nan=False))
    return 2 if result.get('invalidEvidence') else 0 if ok else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, TypeError, IndexError, OverflowError, subprocess.SubprocessError) as error:
        print(json.dumps({'status': 'invalid-or-incomplete', 'error': str(error)}), file=sys.stderr)
        sys.exit(2)
