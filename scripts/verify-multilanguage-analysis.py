"""Mixed-language acceptance through real Graph/CLI, with synthetic worker records.

No model-quality claim: checks discovery, frozen inputs, parser dispatch,
planning/analysis/report wiring, old single-language runs and safety.
Run using the target engine's Python: python -m pytest <this-file> -q.
"""
import json
from pathlib import Path
from unittest.mock import patch

import pytest
from pangea_agent.agent_io import read_json, write_json
from pangea_agent.inventory.languages import file_language, detect_analysis_languages, detect_analysis_language
from pangea_agent.inventory.multilanguage import build_inventory
from pangea_agent.inventory.source_regions import build_source_index
from pangea_agent.inventory.scope_preview import preview_scope
from pangea_agent.inventory.source_access import source_index, source_read
from pangea_agent.cli.run_module_analysis import run_module_analysis, resume_module_analysis
from pangea_agent.cli.adapter_api import bind_action, settle_action
from pangea_agent.cli.source_first_api import plan_write, result_write, work_finish

SOURCES = {
    'worker.c': '#include <stdio.h>\nint main(int argc, char **argv) {\n if (argc < 2) return 2;\n puts(argv[1]);\n return 0;\n}\n',
    'bridge.py': 'import subprocess\nimport sys\ndef run(value):\n    return subprocess.run(["./worker", value], check=True).returncode\nif __name__ == "__main__":\n    sys.exit(run(sys.argv[1]))\n',
    'launch': '#!/usr/bin/env bash\nset -eu\nmain() {\n python3 bridge.py "$1"\n}\nmain "$@"\n',
    'module.lua': 'local function check(x)\n if x then return 1 end\n return 0\nend\nreturn check\n',
}


def fixture(tmp_path, names):
    data = tmp_path / 'data'
    root = data / 'repositories/sample'
    (root / 'src').mkdir(parents=True)
    for name in names:
        (root / 'src' / name).write_text(SOURCES[name], encoding='utf-8')
    return data, root, [{'repo_id': 'sample', 'source_root': str(root)}]


@pytest.mark.parametrize('filename,text,expected', [
    ('a.py', 'def x(): pass\n', 'python'), ('a.pyw', '', 'python'),
    ('a.sh', 'echo hi\n', 'shell'), ('a.bash', '', 'shell'),
    ('run', '#!/bin/sh\necho hi\n', 'shell'),
    ('run', '#!/usr/bin/env -S bash -e\necho hi\n', 'shell'),
    ('run', '#!/usr/bin/env -u FOO python3.12\n', 'python'),
    ('run', '#!/usr/bin/python3\n', 'python'),
    ('wrong.sh', '#!/bin/zsh\n', None), ('run', '#!/usr/bin/fish\n', None),
    ('a.ps1', 'Write-Host hi\n', None), ('binary', '\x00ELF', None),
])
def test_detection(tmp_path, filename, text, expected):
    path = tmp_path / filename
    path.write_text(text)
    assert file_language(path) == expected


def test_scope_parser_and_lossless_regions(tmp_path):
    data, root, repos = fixture(tmp_path, SOURCES)
    (root / 'src/.venv').mkdir()
    (root / 'src/.venv/ignored.py').write_text('raise SystemExit()')
    preview = preview_scope(str(data), 'sample', ['src'])
    assert preview['analysis_languages'] == ['c_cpp', 'lua', 'python', 'shell']
    assert preview['matched_file_count'] == 4
    inventory = build_inventory(repos, ['src', 'src/bridge.py'])
    assert inventory['file_count'] == 4
    assert inventory['structural_parse_complete'], inventory
    assert all(f['functions'] for f in inventory['files'])
    for f in build_source_index(inventory)['files']:
        covered = {n for r in f['regions'] for n in range(r['line_start'], r['line_end'] + 1)}
        assert covered == set(range(1, f['line_count'] + 1))
        assert f['language']
    assert preview_scope(str(data), 'sample', ['src/.venv'])['matched_file_count'] == 0


@pytest.mark.parametrize('name,text', [('bad.py', 'def broken(:\n'), ('bad.sh', 'if then\n')])
def test_parser_errors_preserve_source(tmp_path, name, text):
    path = tmp_path / name
    path.write_text(text)
    inv = build_inventory([{'repo_id': 'r', 'source_root': str(tmp_path)}], ['.'])
    assert inv['file_count'] == 1
    assert not inv['files'][0]['parse_complete']
    assert inv['parse_failures']
    assert build_source_index(inv)['files'][0]['regions']
    assert path.read_text() == text


def test_missing_shell_dependency_keeps_raw_file(tmp_path):
    path = tmp_path / 'a.sh'
    path.write_text('echo hello\n')
    with patch('pangea_agent.inventory.script_source_scanner.parse_shell_file', side_effect=ImportError('tree_sitter_bash')):
        inv = build_inventory([{'repo_id': 'r', 'source_root': str(tmp_path)}], ['.'])
    assert inv['file_count'] == 1 and not inv['structural_parse_complete']
    assert inv['missing_dependencies'] == ['tree-sitter-bash']


def test_never_execute_source_and_reject_escape(tmp_path):
    root = tmp_path / 'repo'
    root.mkdir()
    marker = tmp_path / 'executed'
    (root / 'danger.py').write_text(f'from pathlib import Path\nPath({str(marker)!r}).touch()\n')
    repos = [{'repo_id': 'r', 'source_root': str(root)}]
    build_inventory(repos, ['.'])
    assert not marker.exists()
    (tmp_path / 'outside.py').write_text('x=1')
    (root / 'escape.py').symlink_to(tmp_path / 'outside.py')
    with pytest.raises(ValueError):
        detect_analysis_languages(repos, ['.'])
    with pytest.raises(ValueError):
        detect_analysis_languages(repos, ['../outside.py'])


def test_same_relative_path_different_repositories(tmp_path):
    repos = []
    for repo in ['first', 'second']:
        root = tmp_path / repo
        root.mkdir()
        (root / 'run').write_text('#!/bin/sh\necho hello\n' if repo == 'first' else '#!/usr/bin/python3\nx=1\n')
        repos.append({'repo_id': repo, 'source_root': str(root)})
    assert detect_analysis_language(repos, ['.']) == 'mixed'
    inv = build_inventory(repos, ['.'])
    assert {(f['repo_id'], f['language']) for f in inv['files']} == {('first', 'shell'), ('second', 'python')}


@pytest.mark.parametrize('names,mode,profile', [
    (['worker.c', 'bridge.py', 'launch'], 'speed', 'behavior-test-v2'),
    (['worker.c', 'bridge.py', 'launch'], 'depth', 'behavior-test-v2'),
    (['worker.c'], 'speed', 'behavior-test-v1'),
    (['module.lua'], 'depth', 'behavior-test-v1'),
    (['worker.c'], 'depth', 'behavior-test-v2'),
    (['module.lua'], 'speed', 'behavior-test-v2'),
    (['bridge.py'], 'speed', 'behavior-test-v2'),
    (['launch'], 'speed', 'behavior-test-v2'),
    (list(SOURCES), 'speed', 'behavior-test-v2'),
])
@pytest.mark.parametrize("scenario", ["module-analysis", "risk-analysis", "branch-analysis", "coverage-analysis"])
def test_graph_to_report_and_resume(tmp_path, names, mode, profile, scenario):
    if profile == "behavior-test-v1" and scenario != "module-analysis":
        pytest.skip("v1 only supports module-analysis")
    data, root, repos = fixture(tmp_path, names)
    names = [f'src/{name}' for name in names]
    languages = detect_analysis_languages(repos, ['src'])
    request = tmp_path / 'request.json'
    write_json(request, dict(data_root=str(data), run_id='mixed-run', repository='sample',
        target='脚本启动并将参数传给下游程序', workflow_version='source-first-v1', analysis_profile=profile,
        analysis_settings={'scenario': scenario, 'mode': mode}, source_scope=['src']))
    if scenario == 'coverage-analysis':
        from pangea_agent.assets import import_asset, prepare_asset_extraction, asset_detail
        coverage = tmp_path / 'coverage.json'
        write_json(coverage, {'status': 'success', 'query_resolution': {'status': 'matched'}, 'uncovered_functions': []})
        asset = import_asset(str(data), str(coverage), 'coverage')
        prepare_asset_extraction(str(data), asset.asset_id)
        detail = asset_detail(str(data), asset.asset_id)['asset']
        contract = read_json(request)
        contract.update(asset_ids=[asset.asset_id], asset_revisions={asset.asset_id: detail['input_revision']})
        write_json(request, contract)
    first = run_module_analysis(str(request))
    run = data / 'runs/mixed-run'
    planning = first['agent_actions'][0]
    task = read_json(Path(planning['task_path']))
    assert task['analysis_languages'] == languages
    manifest = read_json(run / 'inputs/source-manifest.json')
    assert {f['path'] for f in manifest['file_languages']} == set(names)
    binding = (str(data), 'mixed-run', planning['action_id'], 'planner-session')
    bind_action(*binding)
    files = source_index(*binding)['files']
    assert {f['path'] for f in files} == set(names)
    for name in names:
        detail = source_index(*binding, repo_id='sample', path=name)
        assert detail['files'][0]['regions']
        original = source_read(*binding, repo_id='sample', path=name, line_start=1)['text']
        (root / name).write_text('modified after freeze')
        assert source_read(*binding, repo_id='sample', path=name, line_start=1)['text'] == original
    saved = plan_write(*binding, expected_revision=0, unit={'title': '联合链路', 'purpose': '同一单元负责入口及下游契约',
        'owned_files': [{'repo_id': 'sample', 'path': name} for name in names]})
    work_finish(*binding, revision=saved['revision'])
    settle_action(*binding[:3])
    progress = read_json(run / 'progress.json')
    action = next(a for a in progress['actions'].values() if a['role'] == 'analysis')
    task = read_json(Path(action['task_path']))
    assert task['analysis_languages'] == languages
    rubrics = {Path(p).stem for p in task['rubric_paths']}
    for lang in set(languages) & {'python', 'shell'}:
        assert f'{lang}_analysis' in rubrics
    if len(languages) > 1:
        assert 'mixed_analysis' in rubrics
    binding = (str(data), 'mixed-run', action['action_id'], 'worker-session')
    bind_action(*binding)
    saved = result_write(*binding, expected_revision=0, records=[{
        'kind': 'summary', 'body': 'Synthetic transport acceptance: all selected languages share a task; not a semantic quality verdict.',
        'evidence': [f'sample:{name}:1' for name in names]}])
    work_finish(*binding, revision=saved['revision'])
    settle_action(*binding[:3])
    # Current upstream flow completes after analysis in both speed and depth modes.
    # Historical review schemas remain covered by test_task_schema_equivalence.
    progress = read_json(run / 'progress.json')
    assert progress['review_policy'] == 'disabled'
    assert not any(a['role'] in {'review', 'closure'} for a in progress['actions'].values())
    assert read_json(Path(task['result_path']))['records']
    assert progress['lifecycle_status'] == 'complete', progress
    assert (run / 'report.md').is_file() and (run / 'report.html').is_file()
    if len(languages) > 1:
        report = (run / 'report.md').read_text()
        assert 'Python' in report and 'sh/Bash' in report and 'C/C++' in report
    frozen = {p: p.read_bytes() for p in (run / 'inputs/methodologies/builtin').glob('*.md')}
    resume_module_analysis('mixed-run', str(data))
    assert all(p.read_bytes() == content for p, content in frozen.items())

    # Derivation creates a separate Run and never rewrites the completed parent.
    if scenario == 'module-analysis' and profile == 'behavior-test-v2' and mode == 'speed':
        from pangea_agent.cli.run_module_analysis import derive_run
        parent_bytes = {p: p.read_bytes() for p in run.rglob('*') if p.is_file()}
        derivation = tmp_path / 'derive.json'
        write_json(derivation, {'mode': 'supplement', 'instruction': '核对跨语言退出码传播'})
        child = derive_run(str(data), 'mixed-run', str(derivation))
        child_task = read_json(Path(child['agent_actions'][0]['task_path']))
        assert child_task['analysis_languages'] == languages
        # A new script in changed-files must not inherit the parent's single language.
        for name in names:
            (root / name).write_text(SOURCES[Path(name).name])
        (root / 'src/new.py').write_text('def added(): return 1\n')
        write_json(derivation, {'mode': 'changed-files', 'changed_paths': ['src/new.py']})
        child = derive_run(str(data), 'mixed-run', str(derivation))
        child_task = read_json(Path(child['agent_actions'][0]['task_path']))
        assert 'python' in child_task['analysis_languages']
        assert all(p.read_bytes() == content for p, content in parent_bytes.items())


@pytest.mark.parametrize('language', ['c_cpp', 'lua'])
def test_old_task_schema_defaults(language):
    from pangea_agent.models.analysis import PlanningTask
    from pangea_agent.models.source_first import SourceFileIndex
    task = PlanningTask.model_validate(dict(run_id='old', target='old target', analysis_language=language,
        repositories=[{'repo_id': 'r', 'source_root': '/old'}], requested_scope=['.'],
        compact_metadata_path='/old/metadata.json', asset_candidates_path='/old/assets.json', result_path='/old/result.json'))
    assert task.analysis_language == language and task.analysis_languages == []
    index = SourceFileIndex.model_validate({'repo_id': 'r', 'path': 'old.c', 'line_count': 1})
    assert index.language is None


def test_task_schema_equivalence():
    import pangea_agent
    from pangea_agent.graph.schema_contract import verify_schema_contract_equivalence
    from pangea_agent.models import analysis
    root = Path(pangea_agent.__file__).parents[2]
    for name, model in [('planning_task', analysis.PlanningTask), ('analysis_task', analysis.AnalysisTask),
                        ('independent_review_task', analysis.IndependentReviewTask),
                        ('comparison_review_task', analysis.ComparisonReviewTask), ('closure_task', analysis.ClosureTask)]:
        verify_schema_contract_equivalence(model, read_json(root / 'schemas' / (name + '.schema.json')))


def test_explicit_script_context_selects_boundary_rules(tmp_path):
    data, root, repos = fixture(tmp_path, ['worker.c', 'bridge.py', 'launch'])
    (root / 'core').mkdir()
    (root / 'src/worker.c').rename(root / 'core/worker.c')
    request = tmp_path / 'context.json'
    write_json(request, dict(data_root=str(data), run_id='context-run', repository='sample', target='worker contract',
        workflow_version='source-first-v1', analysis_profile='behavior-test-v1', source_scope=['core'],
        context_scope=['src/bridge.py', 'src/launch']))
    response = run_module_analysis(str(request))
    task = read_json(Path(response['agent_actions'][0]['task_path']))
    assert task['analysis_languages'] == ['c_cpp', 'python', 'shell']
    assert task['owned_scope_paths'] == [{'repo_id': 'sample', 'path': 'core/worker.c'}]
    assert {p['path'] for p in task['reference_scope_paths']} == {'src/bridge.py', 'src/launch'}
    assert 'mixed_unit_planning.md' in ' '.join(task['rubric_paths'])


@pytest.mark.parametrize('names', [['worker.c'], ['module.lua'], ['bridge.py'], ['launch'], ['worker.c', 'bridge.py', 'launch']])
def test_legacy_preparation_still_produces_consumable_planning_task(tmp_path, names):
    from pangea_agent.models.analysis import PlanningTask
    data, root, repos = fixture(tmp_path, names)
    request = tmp_path / 'legacy.json'
    write_json(request, dict(data_root=str(data), run_id='legacy-run', repository='sample',
        target='legacy preparation', workflow_version='legacy-v1', source_scope=['src']))
    run_module_analysis(str(request))
    run = data / 'runs/legacy-run'
    manifest = read_json(run / 'inputs/source-manifest.json')
    assert manifest['analysis_languages'] == detect_analysis_languages(repos, ['src'])
    progress = read_json(run / 'progress.json')
    planning = next(a for a in progress['actions'].values() if a['role'] == 'planning')
    task = PlanningTask.model_validate(read_json(Path(planning['task_path'])))
    assert task.analysis_languages == manifest['analysis_languages']
    assert all(Path(r).is_file() for r in task.rubric_paths)


@pytest.mark.parametrize('scope', [['.'], ['src/worker.c'], ['missing'], ['../outside'], []])
def test_new_run_rejects_invalid_directory_selection(tmp_path, scope):
    data, root, _ = fixture(tmp_path, ['worker.c'])
    request = tmp_path / 'invalid.json'
    write_json(request, dict(data_root=str(data), run_id='invalid-run', repository='sample',
        target='directory boundary', workflow_version='source-first-v1',
        analysis_profile='behavior-test-v2', source_scope=scope))
    with pytest.raises(ValueError):
        run_module_analysis(str(request))
    assert not (data / 'runs/invalid-run/progress.json').exists()
