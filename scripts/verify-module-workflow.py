"""Five-stage module workflow regression against the selected/staged Agent.

Set PYTHONPATH to Agent src. Fixtures test mechanics, not model analysis quality
or proof of a real independent Reviewer. No live profile or Run is modified.
"""
import contextlib
import importlib.util
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from pangea_agent.skills import SOURCE_ROOT, freeze_skill_package
from pangea_agent.skill_runs import create_skill_run, skill_run_detail
from pangea_agent.assets import import_asset, freeze_asset_inputs


class ModuleWorkflowAcceptance(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pangea-module-check-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / "data"
        self.repo = self.data / "repositories/example"
        self.repo.mkdir(parents=True)
        (self.repo / "sample.c").write_text("int sample(int value) { return value > 0; }\n", encoding="utf-8")
        request = self.root / "request.json"
        self.write(request, {"request_version": "2.0", "run_id": "module-check", "data_root": str(self.data),
                             "repository": "example", "target": "sample", "source_scope": ["sample.c"],
                             "asset_ids": [], "scenario": "module-analysis", "mode": "depth"})
        self.created = create_skill_run(str(request))
        self.run = Path(self.created["run_root"])
        self.skill = Path(self.created["skill"]["root_path"])
        self.manifest = self.created["workflow"]
        spec = importlib.util.spec_from_file_location("module_guard", self.skill / "scripts/run_guard.py")
        self.guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.guard)
        self.call("init", skill_root=str(self.skill), source_raw=str(self.repo), source_verified=str(self.run / "inputs/source/repository"), scenario="module-analysis", mode="depth")
        self.call("ack", ack_all=True, rule=None, file=None)
        self.write(self.run / "内部索引/方法论选择.json", {"schema_version": "1.0", "selected": [
            {"methodology_id": "codetalks-skill", "reason": "模块分析", "evidence": ["example:sample.c:1"]}], "excluded": []})
        self.projection = {"schema_version": "1.0", "run_id": self.run.name, "business_flows": [], "risks": [],
                           "test_cases": [], "evidence": [], "review_issues": []}

    def write(self, path, content):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(content, ensure_ascii=False) if isinstance(content, (dict, list)) else content, encoding="utf-8")

    def state(self):
        return json.loads((self.run / "内部索引/运行状态.json").read_text(encoding="utf-8"))

    def call(self, command, **args):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            getattr(self.guard, "command_" + command)(SimpleNamespace(workspace=str(self.run), **args))
        return json.loads(output.getvalue())

    def publish(self, step):
        self.write(self.run / "内部索引/工作台投影.json", self.projection)
        return self.call("publish_stage", step=step, projection=str(self.run / "内部索引/工作台投影.json"))

    def prepare(self):
        for step, documents in [("01", ["输入与范围.md"]), ("02", ["模块盘点.md", "分析台账.md"])]:
            self.call("start", step=step)
            for document in documents:
                self.write(self.run / "活文档" / document, "# sample\n入口 sample；正数返回 1，其余返回 0。并发和资源不适用：无共享状态或资源操作。\n")
            self.call("complete", step=step)
        self.call("start", step="03")
        self.write(self.run / "活文档/流程讲解/流程-FLOW-1-sample.md", "# FLOW-1\nexample:sample.c:1：正数返回 1；零及负数返回 0。无共享状态与资源操作，相关维度不适用。\n")
        self.write(self.run / "活文档/风险点与SFMEA.md", "# 风险\n此夹具无已证实实现风险，边界补测不冒充缺陷。\n")
        self.write(self.run / "活文档/黑盒测试用例.md", "# 用例\n\n## TC-1：外部输入边界\n**前置条件**：测试接口已连接\n**操作步骤**：\n1. 向测试接口分别发送正数、零和负数\n**预期结果**：依次返回 1、0、0\n**观测方式**：独立接口客户端记录响应\n**清理或恢复**：关闭测试连接\n")
        self.projection["business_flows"] = [{"flow_id": "FLOW-1", "title": "sample"}]
        self.projection["test_cases"] = [{"test_case_id": "TC-1", "linked_risk_ids": [], "evidence_ids": []}]
        self.publish("03")

    def review(self, independent=True):
        self.call("complete", step="03")
        self.call("start", step="04")
        self.write(self.run / "活文档/复核记录.md", "# 复核\nRV-1：补充零输入的外部预期；定向修订 TC-1 后复查。\n")
        self.write(self.run / "内部索引/独立审查状态.json", {"independent": independent,
            "checked_artifacts": ["活文档/流程讲解/流程-FLOW-1-sample.md", "活文档/黑盒测试用例.md"],
            "semantic_verdict": "UNRESOLVED", "summary": "测试夹具声明，不是实际模型复核"})

    def deliver(self):
        self.call("complete", step="04")
        self.call("start", step="05")
        for name in ["风险点与SFMEA.md", "黑盒测试用例.md"]:
            shutil.copyfile(self.run / "活文档" / name, self.run / "正式输出" / name)
        self.write(self.run / "正式输出/完整分析报告.md", "# sample\n[已审流程](../活文档/流程讲解/流程-FLOW-1-sample.md)\n复核声明 UNRESOLVED；未进行真实模型验收。\n")

    def test_short_flow_finishes_five_stages_without_padding_or_fixed_headings(self):
        self.prepare()
        self.assertLess(len((self.run / "活文档/流程讲解/流程-FLOW-1-sample.md").read_text(encoding="utf-8")), 200)
        self.review()
        self.deliver()
        self.call("complete", step="05")
        result = self.call("finalize")
        self.assertTrue(result["ok"])
        self.assertEqual(self.state()["completed_steps"], ["01", "02", "03", "04", "05"])
        self.assertEqual(self.state()["publication"]["step_id"], "05")
        self.assertEqual(len(list((self.run / "正式输出").glob("*.md"))), 3)
        timing = self.state()["performance"]["steps"]["01"]
        self.assertGreaterEqual(timing["duration_ms"], 0)
        self.assertGreater(timing["artifact_bytes_delta"], 0)
        self.assertTrue(self.state()["created_at"].endswith("+08:00"))
        self.assertNotIn("01–09", Path(self.created["request_path"]).read_text(encoding="utf-8"))

    def test_publish_reads_steps_from_bound_flow_document_during_step03(self):
        self.prepare()
        document = "活文档/流程讲解/流程-FLOW-1-sample.md"
        flow = {"flow_id": "FLOW-1", "title": "sample", "mainline_steps": [{"step_id": "S1", "title": "读取输入", "processing": "按输入返回结果"}], "branches": []}
        self.write(self.run / document, "# sample\n实现解释\n```pangea-flow\n" + json.dumps(flow, ensure_ascii=False) + "\n```\n")
        self.projection["business_flows"] = [{"flow_id": "FLOW-1", "title": "sample", "document_path": document}]
        self.publish("03")
        published = json.loads((self.run / "内部索引/工作台投影.json").read_text(encoding="utf-8"))
        self.assertEqual(published["business_flows"][0]["mainline_steps"], flow["mainline_steps"])
        self.assertNotIn("03", self.state()["completed_steps"])
        self.assertEqual(published["publication"]["state"], "draft")

    def test_resume_keeps_complex_flow_cursor_progress_and_review_edits_only_target(self):
        self.prepare()
        complex_path = self.run / "活文档/流程讲解/流程-FLOW-2-recovery.md"
        complex_text = "# FLOW-2\n接入→申请 credit→提交→完成；断链取消。\n状态 READY/WAIT/CANCELLED；失败只释放当前所有者 credit；超时与完成竞争时按 generation 拒绝旧响应。\nBR-2：计数 N-1/N/N+1 与回绕；RESOURCE-1：credit 实体和计数必须一致；EX-1：部分提交失败向上游错误响应传播，下一请求验证资源恢复。\n保护条件待查，标记未决而非漏洞；外部注入断链并独立抓包、检查后续业务，恢复连接。\n"
        self.write(complex_path, complex_text)
        plan = {"version": "1.4.0", "passes": [], "cursor": {"flow_id": "FLOW-2", "branch_id": "BR-2", "next": "核对 generation 保护"}}
        self.write(self.run / "内部索引/运行计划.json", plan)
        self.call("progress", step="03", total=2, completed=1, unit_label="流程", item_id="FLOW-2", item_title="恢复", status="running")
        before = self.state()
        self.call("handoff")
        self.call("init", resume=True)
        self.call("start", step="03")
        self.assertEqual(self.state()["step_progress"], before["step_progress"])
        self.assertEqual(self.state()["performance"], before["performance"])
        self.assertEqual(json.loads((self.run / "内部索引/运行计划.json").read_text(encoding="utf-8")), plan)
        self.assertEqual(complex_path.read_text(encoding="utf-8"), complex_text)
        self.review()
        untouched = (self.run / "活文档/流程讲解/流程-FLOW-1-sample.md").read_bytes()
        self.write(complex_path, complex_text + "\nRV-2 定向修订：补充保护条件证据，保留尚未验证的竞态窗口。\n")
        self.publish("04")
        self.assertEqual(self.state()["current_step"], "04")
        self.assertEqual((self.run / "活文档/流程讲解/流程-FLOW-1-sample.md").read_bytes(), untouched)
        self.assertEqual(self.state()["publication"]["revision"], 2)

    def test_self_review_does_not_complete_depth_review_and_premature_finalize_stays_incomplete(self):
        self.prepare()
        self.review(independent=False)
        with self.assertRaises(SystemExit):
            self.call("complete", step="04")
        self.assertNotIn("04", self.state()["completed_steps"])
        with self.assertRaises(SystemExit):
            self.call("finalize")
        self.assertNotEqual(self.state()["status"], "complete")

    def test_incomplete_delivery_is_repaired_in_place_and_can_resume_last_stage(self):
        self.prepare()
        self.review()
        self.deliver()
        final = self.run / "正式输出/黑盒测试用例.md"
        full = final.read_text(encoding="utf-8")
        self.write(final, "# 用例\n## TC-1：未完成\n")
        with self.assertRaises(SystemExit):
            self.call("complete", step="05")
        self.assertNotIn("05", self.state()["completed_steps"])
        self.call("init", resume=True)
        self.assertEqual(self.state()["current_step"], "05")
        self.write(final, full)
        self.call("complete", step="05")
        self.assertTrue(self.call("finalize")["ok"])

    def test_other_scenarios_retain_nine_step_contract(self):
        frozen = freeze_skill_package(self.root / "regression-skill", "issue-regression")
        manifest = json.loads((frozen / "workflow-manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(len(manifest["steps"]), 9)
        self.assertEqual(manifest["steps"][-1]["id"], "09")

    def test_assets_use_selected_workflow_stages_without_changing_old_freezes(self):
        source = self.root / "design.md"
        self.write(source, "# 设计\n正数返回 1，其余返回 0。")
        asset = import_asset(str(self.data), str(source), "design", "设计")
        old_root = self.root / "old-run"
        old = freeze_asset_inputs(self.data, old_root, "old-run", [asset.asset_id])
        old_path = old_root / "inputs/assets/manifest.json"
        before = old_path.read_bytes()
        new = freeze_asset_inputs(self.data, self.root / "new-run", "new-run", [asset.asset_id], allowed_steps=self.manifest["asset_allowed_steps"])
        self.assertEqual(old["assets"][0]["allowed_steps"], ["02", "03", "04", "08"])
        self.assertEqual(new["assets"][0]["allowed_steps"], ["01", "02", "03", "04"])
        self.assertEqual(old_path.read_bytes(), before)

    def test_python_reader_uses_historical_manifest_without_writes(self):
        legacy = json.loads((self.skill / "legacy-workflow-manifest.json").read_text(encoding="utf-8"))
        legacy["version"] = "1.3.0"
        manifest_path = self.skill / "workflow-manifest.json"
        self.write(manifest_path, legacy)
        metadata_path = self.data / ".pangea/skill-runs/module-check/metadata.json"
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        metadata["skill"]["version"] = "1.3.0"
        self.write(metadata_path, metadata)
        before = (metadata_path.read_bytes(), manifest_path.read_bytes())
        detail = skill_run_detail(str(self.data), "module-check")
        self.assertEqual(detail["skill"]["version"], "1.3.0")
        self.assertEqual(len(detail["workflow"]["steps"]), 9)
        self.assertEqual((metadata_path.read_bytes(), manifest_path.read_bytes()), before)


if __name__ == "__main__":
    unittest.main()
