import hashlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'release'))
import bytepatch


class PinnedPatchTests(unittest.TestCase):
    def setUp(self):
        self.raw = bytes(range(256)) * 8
        self.target = self.raw[:300] + b'project addition' + self.raw[500:]
        self.recipe = bytepatch.create(self.raw, self.target)

    def test_many_targets_share_one_source_hash_but_each_recipe_checks_its_pin(self):
        with patch.object(bytepatch, 'digest', wraps=bytepatch.digest) as fingerprint:
            source = bytepatch.PatchSource(self.raw)
            for _ in range(3):
                output = io.BytesIO()
                source.write_verified(self.recipe, output)
                self.assertEqual(output.getvalue(), self.target)
            self.assertEqual(sum(call.args == (self.raw,) for call in fingerprint.call_args_list), 1)
        for changed in ({'sourceSha256': '0' * 64}, {'sourceBytes': 2}, {'targetSha256': '0' * 64},
                        {'targetBytes': 1}, {'ops': [['copy', 0, len(self.raw) + 1]]}):
            with self.subTest(changed=changed), self.assertRaises(ValueError):
                source.write_verified({**self.recipe, **changed}, io.BytesIO())

    def test_cached_source_cannot_be_changed_after_verification(self):
        buf = bytearray(self.raw)
        source = bytepatch.PatchSource(buf)
        buf[0] ^= 1
        output = io.BytesIO()
        source.write_verified(self.recipe, output)
        self.assertEqual(output.getvalue(), self.target)

    def test_archive_digest_does_not_load_the_entire_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'input.bin'
            data = self.raw * 2048
            path.write_bytes(data)
            with patch.object(Path, 'read_bytes', side_effect=AssertionError('unbounded file read')):
                self.assertEqual(bytepatch.file_digest(path), hashlib.sha256(data).hexdigest())


if __name__ == '__main__':
    unittest.main()
