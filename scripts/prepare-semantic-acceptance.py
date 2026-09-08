"""Prepare an isolated depth Run through the real asset and Run APIs.

Does not start a model, read credentials, alter installed profiles, or mark
workflow steps complete. The caller must choose a new, empty output path.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--agent-root', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    agent = Path(args.agent_root).resolve()
    output = Path(args.output).resolve()
    if output.exists():
        raise SystemExit('Refusing to overwrite an existing acceptance directory')
    sys.path.insert(0, str(agent / 'src'))
    from pangea_agent.cli.public_api import import_asset
    from pangea_agent.skill_runs import create_skill_run
    from pangea_agent.documents.source_snapshot import verify_source_snapshot

    fixture = Path(__file__).parent / 'fixtures/semantic-queue'
    data = output / 'pangea-data'
    repository = data / 'repositories/message-queue'
    repository.mkdir(parents=True)
    for name in ('mq.c', 'mq.h'):
        shutil.copy2(fixture / name, repository / name)
    design = import_asset(str(data), str(fixture / 'design.md'), 'design', '消息队列完整设计契约')
    coverage = import_asset(str(data), str(fixture / 'coverage.xlsx'), 'coverage', '合成覆盖率（非执行证据）')
    request = {'request_version': '2.0', 'run_id': 'semantic-queue-depth', 'data_root': str(data),
               'repository': 'message-queue', 'target': '消息队列全量分析', 'source_scope': ['mq.c', 'mq.h'],
               'asset_ids': [design.asset_id, coverage.asset_id], 'scenario': 'module-analysis', 'mode': 'depth'}
    request_path = output / 'request.json'
    request_path.write_text(json.dumps(request, ensure_ascii=False, indent=2), encoding='utf-8')
    result = create_skill_run(str(request_path))
    run = data / 'runs' / request['run_id']
    verify_source_snapshot(run / 'inputs/source')
    manifest = json.loads((run / 'inputs/assets/manifest.json').read_text(encoding='utf-8'))
    assert len(manifest['assets']) == 2
    for asset in manifest['assets']:
        assert hashlib.sha256(Path(asset['frozen_source_path']).read_bytes()).hexdigest() == asset['source_sha256']
    summary = {'request': request, 'created': result, 'assets': manifest['assets'],
               'model_run_started': False, 'source_snapshot_verified': True}
    (output / 'preparation.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({'run_id': request['run_id'], 'mode': 'depth', 'asset_ids': request['asset_ids'],
                      'allowed_steps': {a['asset_type']: a['allowed_steps'] for a in manifest['assets']},
                      'source_snapshot_verified': True, 'model_run_started': False}, ensure_ascii=False))


if __name__ == '__main__':
    main()
