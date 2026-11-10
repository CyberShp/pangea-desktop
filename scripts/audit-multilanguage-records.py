"""Read-only extraction of actual model records for manual semantic acceptance."""
import argparse
from collections import Counter
import json
from pathlib import Path
from pangea_agent.graph.result_store import read_result, active_records

parser = argparse.ArgumentParser()
parser.add_argument('--run-root', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
progress = json.loads((args.run_root/'progress.json').read_text())
manifest = json.loads((args.run_root/'inputs/source-manifest.json').read_text())
actions = []
lines = ['# Actual model record review', '', 'This is a read-only projection. Record counts and workflow status are not semantic acceptance.', '']
for action_id, action in progress['actions'].items():
    task = json.loads(Path(action['task_path']).read_text())
    result_path = Path(task['result_path'])
    result = read_result(result_path)
    records = [r.model_dump(mode='json') for r in active_records(result)]
    actions.append(dict(action_id=action_id, stage=action['stage'], status=action['status'], task_id=action.get('task_id'),
                        task_path=action['task_path'], result_path=str(result_path), analysis_languages=task.get('analysis_languages'),
                        revision=result.revision, completion=result.completion.model_dump(mode='json') if result.completion else None,
                        record_counts=dict(Counter(r['kind'] for r in records)), records=records))
    lines.extend([f"## {action['stage']} / {action_id}", '', f"Status: {action['status']}; revision: {result.revision}", ''])
    for record in records:
        lines.extend([f"### {record['kind']} / {record['record_id']}", '', '```json', json.dumps(record,ensure_ascii=False,indent=2), '```', ''])
args.output.mkdir(parents=True, exist_ok=True)
payload=dict(run_root=str(args.run_root), lifecycle_status=progress.get('lifecycle_status'), quality_status=progress.get('quality_status'),
             analysis_languages=manifest.get('analysis_languages'), actions=actions)
(args.output/'records.json').write_text(json.dumps(payload,ensure_ascii=False,indent=2)+'\n')
(args.output/'records.md').write_text('\n'.join(lines))
print(json.dumps({'lifecycle':progress.get('lifecycle_status'),'actions':[{k:a[k] for k in ['stage','status','record_counts']} for a in actions]},ensure_ascii=False))
