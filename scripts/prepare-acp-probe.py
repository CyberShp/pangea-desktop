"""Create/read an isolated diagnostic Run through the production Python API."""
import json
from pathlib import Path
import sys

action, runtime, scratch = sys.argv[1:4]
sys.path.insert(0, str(Path(runtime) / "src"))
from pangea_agent.skill_runs import create_skill_run
from pangea_agent.cli.public_api import run_detail

root = Path(scratch).resolve()
data = root / "data"
if action == "prepare":
    repository = data / "repositories" / "acp-probe"
    repository.mkdir(parents=True)
    (repository / "probe.c").write_text("int probe(void) { return 0; }\n", encoding="utf-8")
    request = root / "request.json"
    request.write_text(json.dumps({
        "request_version": "2.0", "run_id": "acp-probe", "data_root": str(data),
        "repository": "acp-probe", "target": "ACP initialization probe",
        "source_scope": ["probe.c"], "scenario": "module-analysis", "mode": "speed",
    }), encoding="utf-8")
    result = create_skill_run(str(request))
elif action == "read":
    result = run_detail(str(data), "acp-probe")
else:
    raise ValueError("unknown probe action")
print(json.dumps(result, ensure_ascii=False))
