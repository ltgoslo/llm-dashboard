import json
import tempfile
import unittest
from pathlib import Path

from check_corrupt import check_results_file


class CheckResultsFileTests(unittest.TestCase):
    def test_result_shapes(self):
        cases = [
            ({"results": {"task": {"acc,none": 0.5}}}, None),
            ({"results": {"task": {}}}, None),
            ({"results": {"task": {"label": "ø"}}}, None),
            ({"results": [1]}, "unexpected 'results' type"),
            ({"results": "bad"}, "unexpected 'results' type"),
            ({"results": None}, "unexpected 'results' type"),
            ({"results": []}, "unexpected 'results' type"),
            ({"results": {"task": 42}}, "unexpected result type"),
            ({"results": {"task": []}}, "unexpected result type"),
            ({"results": {}}, "empty 'results' dict"),
            ({}, "missing 'results' key"),
            ([], "unexpected top-level type"),
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "results_test.json"
            for payload, expected in cases:
                with self.subTest(payload=payload):
                    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
                    result = check_results_file(path)
                    if expected is None:
                        self.assertIsNone(result)
                    else:
                        self.assertIn(expected, result)

    def test_invalid_files(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "results_test.json"
            for raw, expected in [(b"", "empty file"), (b"{", "invalid JSON"),
                                  (bytes([255]), "invalid JSON")]:
                with self.subTest(raw=raw):
                    path.write_bytes(raw)
                    self.assertIn(expected, check_results_file(path))


if __name__ == "__main__":
    unittest.main()
