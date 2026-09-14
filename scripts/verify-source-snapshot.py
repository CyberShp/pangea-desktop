"""Verify the staged Agent's current frozen-source access contract.

The old source_snapshot module was removed from pangea-agent. Desktop now
validates the read-only source_access boundary that source-first workers use.
Run locally with the Agent src directory on PYTHONPATH; Windows assembly runs
this script against the embedded Python and staged Agent.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from pangea_agent.inventory import source_access


class FrozenSourceAccessAcceptance(unittest.TestCase):
    def test_current_source_access_surface_is_importable(self):
        for name in (
            "task_open",
            "input_read",
            "source_index",
            "source_read",
            "source_search",
            "resolve_binding",
        ):
            self.assertTrue(callable(getattr(source_access, name, None)), name)

    def test_source_paths_are_normalized_without_leaving_repository(self):
        self.assertEqual(source_access._normal_path(r"src\driver.c"), "src/driver.c")
        self.assertEqual(source_access._normal_path("src/./driver.c"), "src/driver.c")
        for value in ("../driver.c", "src/../../driver.c", "/driver.c", ""):
            with self.subTest(value=value):
                with self.assertRaises(source_access.SourceAccessError):
                    source_access._normal_path(value)

    def test_run_identifiers_cannot_become_paths(self):
        self.assertEqual(source_access._safe_identifier("run-123", "run_id"), "run-123")
        for value in ("", ".", "..", "runs/other", r"runs\other"):
            with self.subTest(value=value):
                with self.assertRaises(source_access.SourceAccessError):
                    source_access._safe_identifier(value, "run_id")

    def test_missing_run_fails_inside_data_root_boundary(self):
        with tempfile.TemporaryDirectory(prefix="pangea-source-access-check-") as directory:
            root = Path(directory)
            (root / "runs").mkdir()
            with self.assertRaises(source_access.SourceAccessError) as caught:
                source_access.resolve_binding(
                    str(root), "missing-run", "action-1", "task-1"
                )
            self.assertIn("Run", str(caught.exception))


if __name__ == "__main__":
    unittest.main(verbosity=2)
