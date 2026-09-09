"""Isolated mechanical regression and raw input preparation for Skill forward tests.

Set PYTHONPATH to the selected Agent src. --prepare DIR creates a new speed Run;
it does not manufacture analysis results or Reviewer claims.
"""
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

from pangea_agent.documents.coverage_input import coverage_page, prepare_coverage, projection_traceability_warnings
from pangea_agent.skill_runs import create_skill_run
from pangea_agent.assets import import_asset

FIXTURE = Path(__file__).resolve().parents[1] / "test/fixtures/coverage-path-quality"
FUNCTIONS = ["set_secret", "release_session", "authenticate", "open_secure", "open_plain",
             "submit_admin", "complete_admin", "abort_admin", "disconnect", "completed_count", "check_datagram"]


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def prepare(root):
    root = root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    data = root / "data"
    repo = data / "repositories/service"
    repo.mkdir(parents=True)
    shutil.copy2(FIXTURE / "transport.c", repo / "transport.c")
    report = root / "coverage.json"
    write(report, {"status": "success", "sources": [], "missing": [], "warnings": [],
                   "uncovered_functions": [{"source": "synthetic", "file_path": "transport.c", "uncovered_functions": FUNCTIONS}],
                   "uncovered_lines": [], "uncovered_branches": []})
    asset = import_asset(str(data), str(FIXTURE / "interface.md"), "design", "合成服务接口")
    request = root / "request.json"
    write(request, {"request_version": "2.0", "run_id": "coverage-forward", "data_root": str(data),
                    "repository": "service", "target": "SecureLink 安全传输", "source_scope": [],
                    "asset_ids": [asset.asset_id], "scenario": "coverage-analysis", "mode": "speed",
                    "coverage_input": {"kind": "file", "path": str(report)}})
    return create_skill_run(str(request))


class CoverageTraceability(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="coverage-path-")
        self.addCleanup(self.tmp.cleanup)
        self.run = Path(prepare(Path(self.tmp.name))["run_root"])
        prepare_coverage(self.run)
        self.projection = {"schema_version": "1.0", "run_id": self.run.name,
                           "business_flows": [{"flow_id": "F1", "mainline_steps": [{"step_id": "S1"}], "branches": []}],
                           "test_cases": [{"test_case_id": "C1", "linked_flow_ids": ["F1"]}],
                           "risks": [], "evidence": [], "review_issues": [], "coverage_gaps": []}

    def publish(self):
        write(self.run / "内部索引/工作台投影.json", self.projection)

    def test_raw_facts_and_unclassified_records_are_visible_before_analysis(self):
        page = coverage_page(self.run, limit=3)
        self.assertEqual(page["scope_summary"]["unclassified"], len(FUNCTIONS))
        self.assertEqual(page["scope_summary"]["designed_in_scope"], 0)
        self.assertEqual(page["next_cursor"], 3)
        self.assertEqual(coverage_page(self.run, cursor=3)["items"][0]["gap_id"], "GAP-000004")

    def test_scope_filter_retains_ids_and_counts_full_input_without_classifying_names(self):
        self.projection["coverage_gaps"] = [
            {"gap_id": "GAP-000001", "scope_status": "in_scope", "scope_reason": "fixture statement", "linked_flow_ids": ["F1"], "linked_test_case_ids": ["C1"]},
            {"gap_id": "GAP-000002", "scope_status": "unresolved", "scope_reason": "fixture uncertainty"},
            {"gap_id": "GAP-000005", "scope_status": "out_of_scope", "scope_reason": "fixture statement"}]
        self.publish()
        page = coverage_page(self.run, scope_status="out_of_scope")
        self.assertEqual([x["gap_id"] for x in page["items"]], ["GAP-000005"])
        summary = page["scope_summary"]
        self.assertEqual(sum(summary[k] for k in ("in_scope", "out_of_scope", "unresolved", "unclassified")), len(FUNCTIONS))
        self.assertEqual(summary["designed_in_scope"], 1)
        self.assertEqual(coverage_page(self.run, flow_id="F1")["total"], 1)
        self.assertEqual(coverage_page(self.run, query="open_secure")["items"][0]["scope_status"], "unclassified")

    def test_projection_cannot_rewrite_raw_fact_or_silently_resolve_duplicates(self):
        self.projection["coverage_gaps"] = [
            {"gap_id": "GAP-000001", "raw": "different", "coverage_status": "covered", "scope_status": "in_scope"},
            {"gap_id": "GAP-000001", "scope_status": "out_of_scope"},
            {"gap_id": "not-in-report", "scope_status": "in_scope"}]
        self.publish()
        page = coverage_page(self.run)
        self.assertEqual(page["items"][0]["raw"], FUNCTIONS[0])
        self.assertEqual(page["items"][0]["coverage_status"], "uncovered")
        self.assertEqual(page["items"][0]["scope_status"], "unclassified")
        self.assertGreaterEqual(len(page["traceability_warnings"]), 3)

    def test_readable_shape_issues_are_advisory_and_repairable(self):
        self.projection["business_flows"][0].pop("mainline_steps")
        self.publish()
        before = (self.run / "内部索引/工作台投影.json").read_bytes()
        self.assertTrue(projection_traceability_warnings(self.projection))
        self.assertEqual(coverage_page(self.run)["total"], len(FUNCTIONS))
        self.assertEqual(before, (self.run / "内部索引/工作台投影.json").read_bytes())
        self.projection["business_flows"][0]["mainline_steps"] = [{"step_id": "S1"}]
        self.assertEqual(projection_traceability_warnings(self.projection), [])
        self.projection["business_flows"].append({"flow_id": "F2", "mainline_steps": [{"step_id": "S2"}]})
        self.projection["test_cases"][0]["linked_flow_ids"] = ["F1", "F2"]
        self.assertEqual(projection_traceability_warnings(self.projection), [])

    def test_other_run_and_unreadable_projection_never_supply_scope(self):
        self.projection["run_id"] = "other"
        self.projection["coverage_gaps"] = [{"gap_id": "GAP-000001", "scope_status": "in_scope"}]
        self.publish()
        self.assertEqual(coverage_page(self.run)["scope_summary"]["in_scope"], 0)
        (self.run / "内部索引/工作台投影.json").write_text("{", encoding="utf-8")
        self.assertEqual(coverage_page(self.run)["total"], len(FUNCTIONS))

    def test_malformed_annotation_warns_without_losing_raw_input(self):
        self.projection["business_flows"][0]["branches"] = [{"branch_id": "B1", "from_step_id": {}, "to_step_id": []}]
        self.projection["coverage_gaps"] = [{"gap_id": "GAP-000001", "scope_status": "in_scope", "scope_reason": None,
                                              "linked_flow_ids": [{}], "linked_test_case_ids": [{}]}]
        self.publish()
        page = coverage_page(self.run)
        self.assertEqual(page["total"], len(FUNCTIONS))
        self.assertEqual(page["scope_summary"]["designed_in_scope"], 0)
        self.assertTrue(any("范围声明缺少依据" in warning for warning in page["traceability_warnings"]))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--prepare":
        print(json.dumps(prepare(Path(sys.argv[2])), ensure_ascii=True))
    else:
        unittest.main()
