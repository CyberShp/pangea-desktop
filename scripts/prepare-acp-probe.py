"""Create/read an isolated diagnostic Run through the production Python API."""
import json
from pathlib import Path
import sys

action, runtime, scratch = sys.argv[1:4]
sys.path.insert(0, str(Path(runtime) / "src"))
from pangea_agent.cli.public_api import run_detail

root = Path(scratch).resolve()
data = root / "data"
run_root = data / "runs" / "acp-probe"
contract_path = root / "contract.json"

if action == "prepare":
    repository = data / "repositories" / "acp-probe"
    (repository / "src").mkdir(parents=True, exist_ok=True)
    (repository / "src" / "probe.c").write_text("int probe(void) { return 0; }\n", encoding="utf-8")
    contract_path.write_text(json.dumps({
        "workflow_version": "source-first-v1",
        "run_id": "acp-probe",
        "data_root": str(data),
        "repository": "acp-probe",
        "target": "ACP initialization probe",
        "source_scope": ["src"],
        "analysis_settings": {"scenario": "module-analysis", "mode": "speed"},
    }, ensure_ascii=False), encoding="utf-8")
    result = {
        "contract_path": str(contract_path),
        "request_path": str(contract_path),
        "run_root": str(run_root),
        "data_root": str(data),
    }
elif action == "init":
    from pangea_agent.cli.run_module_analysis import run_module_analysis
    raw = run_module_analysis(str(contract_path))
    result = {
        "ok": True,
        "run_id": raw.get("run_id", "acp-probe") if isinstance(raw, dict) else "acp-probe",
        "phase": raw.get("phase") if isinstance(raw, dict) else None,
        "status": raw.get("status") if isinstance(raw, dict) else None,
    }
elif action == "read":
    result = run_detail(str(data), "acp-probe")
else:
    raise ValueError("unknown probe action")
print(json.dumps(result, ensure_ascii=False))
