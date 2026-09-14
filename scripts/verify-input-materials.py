"""Verify current asset input handling used by source-first Runs.

The previous verifier depended on the retired coverage_input/skill_runs flow.
This check exercises the asset APIs still shipped by the langgraph Agent and
keeps all data inside an isolated temporary data root.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from pangea_agent.assets import import_asset, load_asset, prepare_asset_extraction
from pangea_agent.cli.adapter_api import bind_asset_action, settle_asset_action
import json


class InputMaterialAcceptance(unittest.TestCase):
    def test_interrupted_extraction_preserves_binding_and_accepts_only_submitted_result(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "需求.md"
            source.write_text("# 需求\nTLS 连接", encoding="utf-8")
            asset = import_asset(directory, str(source), "requirement", "TLS")
            prepared = prepare_asset_extraction(directory, asset.asset_id)
            action_id = prepared["action"]["action_id"]
            bind_asset_action(directory, asset.asset_id, action_id, "real-session")
            resumed = prepare_asset_extraction(directory, asset.asset_id)
            self.assertEqual(resumed["action"]["task_id"], "real-session")
            self.assertEqual(resumed["asset"]["status"], "extracting")
            with self.assertRaises((OSError, ValueError)):
                settle_asset_action(directory, asset.asset_id, action_id)
            task = json.loads(Path(resumed["action"]["task_path"]).read_text(encoding="utf-8"))
            Path(task["result_path"]).write_text(json.dumps({"asset_id": asset.asset_id, "items": [], "summary": "原文无可提取条目", "warnings": ["原文无可提取条目"]}), encoding="utf-8")
            accepted = settle_asset_action(directory, asset.asset_id, action_id)
            self.assertEqual(accepted["asset"]["status"], "no_items")

    def test_document_asset_is_copied_and_reloadable(self):
        with tempfile.TemporaryDirectory(prefix="pangea-input-materials-") as directory:
            root = Path(directory)
            source = root / "reference.md"
            source.write_text("# Reference\nsource-first fixture\n", encoding="utf-8")

            record = import_asset(str(root), str(source), "reference", "Reference")
            loaded = load_asset(str(root), record.asset_id)

            self.assertEqual(loaded.asset_id, record.asset_id)
            self.assertEqual(loaded.asset_type, "reference")
            self.assertEqual(loaded.title, "Reference")
            copied = Path(loaded.source_path)
            self.assertTrue(copied.is_file())
            self.assertEqual(copied.read_text(encoding="utf-8"), source.read_text(encoding="utf-8"))
            self.assertEqual(copied.parent.parent, root / "inbox")

    def test_asset_type_file_constraints_are_enforced(self):
        with tempfile.TemporaryDirectory(prefix="pangea-input-materials-") as directory:
            root = Path(directory)
            markdown = root / "coverage.md"
            markdown.write_text("not xlsx", encoding="utf-8")
            with self.assertRaises(ValueError):
                import_asset(str(root), str(markdown), "coverage", "Coverage")

            binary = root / "reference.bin"
            binary.write_bytes(b"fixture")
            with self.assertRaises(ValueError):
                import_asset(str(root), str(binary), "reference", "Reference")


if __name__ == "__main__":
    unittest.main(verbosity=2)
