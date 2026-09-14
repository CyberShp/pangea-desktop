"""Verify current coverage matching and zero-coverage selection semantics.

The retired coverage-analysis skill_run verifier depended on coverage_input and
skill_runs modules that are not part of the langgraph Agent. This smoke test
uses the coverage contract consumed by source-first directly.
"""

from __future__ import annotations

import unittest

from pangea_agent.documents.coverage import match_coverage_records, relevant_zero_coverage


class CoveragePathAcceptance(unittest.TestCase):
    def setUp(self):
        self.inventory = {
            "files": [
                {
                    "repo_id": "repo-a",
                    "path": "src/tls.c",
                    "functions": [
                        {"symbol": "handshake", "line": 10},
                        {"symbol": "covered", "line": 20},
                    ],
                }
            ]
        }

    def test_function_records_match_normalized_paths(self):
        records = [
            {
                "coverage_type": "function",
                "module": "tls",
                "path": r"src\\tls.c",
                "function": "handshake",
                "count": 0,
            },
            {
                "coverage_type": "function",
                "module": "tls",
                "path": "src/tls.c",
                "function": "covered",
                "count": 3,
            },
            {
                "coverage_type": "function",
                "module": "tls",
                "path": "src/tls.c",
                "function": "missing",
                "count": 0,
            },
        ]
        report = match_coverage_records(records, self.inventory)
        self.assertEqual([item["function"] for item in report["matched"]], ["handshake", "covered"])
        self.assertEqual([item["function"] for item in report["unmatched"]], ["missing"])
        zero = relevant_zero_coverage(report)
        self.assertEqual([item["function"] for item in zero], ["handshake"])
        self.assertEqual(zero[0]["matches"][0]["path"], "src/tls.c")

    def test_partially_uncovered_branch_is_relevant(self):
        records = [
            {
                "coverage_type": "branch",
                "branch_id": "B1",
                "module": "tls",
                "path": "src/tls.c",
                "function": "handshake",
                "condition": "secure",
                "true_count": 4,
                "false_count": 0,
                "count": 4,
            }
        ]
        report = match_coverage_records(records, self.inventory)
        zero = relevant_zero_coverage(report)
        self.assertEqual(len(zero), 1)
        self.assertEqual(zero[0]["branch_id"], "B1")
        self.assertEqual(zero[0]["meaning"], "branch_execution_reference_only")


if __name__ == "__main__":
    unittest.main(verbosity=2)
