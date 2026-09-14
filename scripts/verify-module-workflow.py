"""Verify the staged source-first LangGraph workflow contract.

The previous verifier exercised the retired five-stage skill_run/run_guard flow.
Current langgraph builds validate the graph wiring and source-first scope helpers
that are actually shipped in pangea-agent.
"""

from __future__ import annotations

import unittest
import json
import tempfile
from pathlib import Path
from pangea_agent.cli.source_first_api import _plan_diagnostics
from pangea_agent.models.source_first import NotesResult, NoteRecord, SourceBinding

from pangea_agent.graph.graph import graph
from pangea_agent.graph.nodes import source_first


class SourceFirstWorkflowAcceptance(unittest.TestCase):
    def test_target_scope_can_select_tls_without_forcing_other_protocol_functions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "inputs").mkdir()
            regions = [dict(region_id=name, repo_id="repo", path="tcp.c", kind="function") for name in ("tls", "crc")]
            (root / "inputs" / "source-index.json").write_text(json.dumps({"files": [{"repo_id": "repo", "path": "tcp.c", "regions": regions}]}), encoding="utf-8")
            result = NotesResult(binding=SourceBinding(data_root=directory, run_id="run", action_id="planning", task_id="worker"), revision=1,
                records=[NoteRecord(record_id="p1", kind="unit_plan", created_revision=1, body={"unit_id": "tls", "owned_regions": ["tls"]})])
            task = {"owned_scope_paths": [{"repo_id": "repo", "path": "tcp.c"}]}
            self.assertFalse(_plan_diagnostics(root, task, result)["ready"])
            task["scope_policy"] = "target-first-v1"
            diagnostic = _plan_diagnostics(root, task, result)
            self.assertTrue(diagnostic["ready"])
            self.assertEqual(diagnostic["unassigned_owned_regions"], ["crc"])
            result.records[0].body["owned_regions"] = ["unknown"]
            self.assertFalse(_plan_diagnostics(root, task, result)["ready"])

    def test_graph_and_source_first_runtime_are_importable(self):
        self.assertIsNotNone(graph)
        for name in ("_safe_key", "_all_scope_paths", "_scope_paths"):
            self.assertTrue(callable(getattr(source_first, name, None)), name)

    def test_scope_paths_are_normalized_and_deduplicated(self):
        expansion = {
            "groups": [
                {
                    "repo_id": "repo-a",
                    "code_paths": [r"src\driver.c", "src/driver.c"],
                    "context_paths": [r"include\driver.h"],
                }
            ]
        }
        self.assertEqual(
            source_first._all_scope_paths(expansion),
            [
                {"repo_id": "repo-a", "path": "src/driver.c"},
                {"repo_id": "repo-a", "path": "include/driver.h"},
            ],
        )
        self.assertEqual(
            source_first._scope_paths(expansion, "code_paths"),
            [{"repo_id": "repo-a", "path": "src/driver.c"}],
        )

    def test_safe_keys_are_stable_and_bounded(self):
        self.assertEqual(source_first._safe_key("A B/C"), "A-B-C")
        self.assertEqual(source_first._safe_key("///", fallback="unit"), "unit")
        self.assertLessEqual(len(source_first._safe_key("x" * 200)), 80)


if __name__ == "__main__":
    unittest.main(verbosity=2)
