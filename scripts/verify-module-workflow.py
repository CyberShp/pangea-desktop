"""Verify the staged source-first LangGraph workflow contract.

The previous verifier exercised the retired five-stage skill_run/run_guard flow.
Current langgraph builds validate the graph wiring and source-first scope helpers
that are actually shipped in pangea-agent.
"""

from __future__ import annotations

import unittest

from pangea_agent.graph.graph import graph
from pangea_agent.graph.nodes import source_first


class SourceFirstWorkflowAcceptance(unittest.TestCase):
    def test_graph_and_source_first_runtime_are_importable(self):
        self.assertIsNotNone(graph)
        for name in ("_safe_key", "_all_scope_paths", "_scope_paths"):
            self.assertTrue(callable(getattr(source_first, name, None)), name)

    def test_scope_paths_are_normalized_and_deduplicated(self):
        expansion = {
            "groups": [
                {
                    "repo_id": "repo-a",
                    "code_paths": [r"src\\driver.c", "src/driver.c"],
                    "context_paths": [r"include\\driver.h"],
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
