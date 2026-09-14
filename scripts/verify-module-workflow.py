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
from pangea_agent.inventory.scope_expander import budget_automatic_context


class SourceFirstWorkflowAcceptance(unittest.TestCase):
    def test_reference_budget_preserves_sources_and_records_omissions(self):
        expansion = {"groups": [{"repo_id": "r", "code_paths": ["tcp.c"],
            "context_paths": ["tcp.c", *[f"helpers/{i}.c" for i in range(100)], "public.h"]}],
            "context_files": [{"repo_id": "r", "path": f"helpers/{i}.c", "reason": "direct_callee_definition:helper"} for i in range(100)]
                + [{"repo_id": "r", "path": "public.h", "reason": "declared_definition:entry"}]}
        budget_automatic_context(expansion)
        self.assertEqual(expansion["groups"][0]["code_paths"], ["tcp.c"])
        self.assertEqual(len(expansion["groups"][0]["context_paths"]), 64)
        self.assertIn("public.h", expansion["groups"][0]["context_paths"])
        self.assertEqual(expansion["context_budget"]["omitted_file_count"], 37)
        self.assertNotIn("tcp.c", expansion["groups"][0]["context_paths"])

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


class OnDemandPlanningAcceptance(unittest.TestCase):
    def test_asset_restart_preserves_previous_attempt(self):
        from pangea_agent.assets import import_asset, prepare_asset_extraction
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "requirements.txt"
            source.write_text("TLS authentication requirement", encoding="utf-8")
            asset = import_asset(temp, str(source), "requirement")
            first = prepare_asset_extraction(temp, asset.asset_id)
            result = Path(first["asset"]["result_path"])
            result.write_text("original partial result", encoding="utf-8")
            same = prepare_asset_extraction(temp, asset.asset_id)
            self.assertEqual(same["action"]["action_id"], first["action"]["action_id"])
            second = prepare_asset_extraction(temp, asset.asset_id, restart=True)
            self.assertNotEqual(second["action"]["action_id"], first["action"]["action_id"])
            self.assertNotEqual(second["asset"]["result_path"], str(result))
            self.assertEqual(result.read_text(encoding="utf-8"), "original partial result")
            self.assertTrue(Path(first["action"]["task_path"]).is_file())

    def test_large_unrelated_tree_stays_lazy_and_resume_uses_real_cli(self):
        import json, os, subprocess, sys, tempfile
        from unittest.mock import patch
        from pangea_agent.cli.run_module_analysis import run_module_analysis
        from pangea_agent.cli.adapter_api import bind_action
        from pangea_agent.cli.source_first_api import task_open, plan_write, work_finish
        from pangea_agent.inventory.source_access import source_index, source_read
        from pangea_agent.agent_io import write_json, read_json
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = root / "data"
            repo = data / "repositories" / "sample"
            (repo / "backend").mkdir(parents=True)
            (repo / "tls.c").write_text("int tls_connect(void) { return 0; }\n")
            for i in range(500):
                (repo / "backend" / f"disk{i}.c").write_text(f"int disk{i}(void) {{ return 0; }}\n")
            request = root / "request.json"
            write_json(request, {"data_root": str(data), "run_id": "lazy-run", "repository": "sample",
                "target": "TLS connect", "source_scope": ["."], "workflow_version": "source-first-v1"})
            with patch("pangea_agent.inventory.source_scanner.parse_cpp_file", side_effect=AssertionError("eager parse")):
                run_module_analysis(str(request))
            run = data / "runs" / "lazy-run"
            self.assertEqual(read_json(run / "inputs/source-index.json")["file_count"], 501)
            self.assertFalse((run / "inputs/source-details").exists())
            binding = (str(data), "lazy-run", "lazy-run:planning", "original-worker")
            bind_action(*binding)
            opened = task_open(*binding)
            self.assertNotIn("allowed_paths", opened["task"])
            self.assertLess(len(json.dumps(opened)), 12000)
            self.assertEqual(opened["write_contract"]["revision"], 0)
            page = source_index(*binding, repo_id="sample", path="backend", page_size=4)
            self.assertEqual(len(page["files"]), 4)
            self.assertFalse((run / "inputs/source-details").exists())
            selected = source_index(*binding, repo_id="sample", path="tls.c")
            self.assertTrue((run / "inputs/source-details/sample/tls.c.json").is_file())
            self.assertEqual(len(list((run / "inputs/source-details").rglob("*.json"))), 1)
            function = next(r for r in selected["files"][0]["regions"] if r["kind"] == "function")
            self.assertIn("tls_connect", json.dumps(source_read(*binding, repo_id="sample", region_id=function["region_id"])))
            saved = plan_write(*binding, expected_revision=0, unit={"title":"TLS", "purpose":"连接", "owned_files":[{"repo_id":"sample","path":"tls.c"}]})
            work_finish(*binding, revision=saved["revision"])
            before = (run / "agent-results/source-first/planning.json").read_bytes()
            command = [sys.executable, "-m", "pangea_agent.cli.main", "runs", "resume", "--data-root", str(data), "--run-id", "lazy-run"]
            result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", env={**os.environ, "PYTHONUTF8":"1"})
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            action = read_json(run / "progress.json")["actions"]["lazy-run:planning"]
            self.assertEqual(action["task_id"], "original-worker")
            self.assertEqual(action["action"], "continue_agent")
            self.assertEqual(action["status"], "pending")
            self.assertEqual((run / "agent-results/source-first/planning.json").read_bytes(), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
