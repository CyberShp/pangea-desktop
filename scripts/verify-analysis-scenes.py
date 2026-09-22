"""Exercise scene contracts through the real Graph; no model or user data needed."""
import json
from hashlib import sha256
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from pangea_agent.agent_io import read_json, write_json
from pangea_agent.analysis_scenarios import SCENES
from pangea_agent.assets import import_asset, prepare_asset_extraction, asset_detail, analysis_asset_inputs
from pangea_agent.cli.adapter_api import bind_action, settle_action
from pangea_agent.cli.run_module_analysis import run_module_analysis, resume_module_analysis
from pangea_agent.cli.source_first_api import plan_write, result_write, work_finish, review_decide, task_open, input_read, comparison_finding_write, result_supersede
from pangea_agent.models.contract import TaskContract
from pangea_agent.methodology import freeze_enabled_methodologies


class SceneAcceptance(unittest.TestCase):
    def test_frozen_methodology_bytes_survive_windows_writes_and_resume(self):
        original_open = Path.open

        def windows_open(path, mode='r', buffering=-1, encoding=None, errors=None, newline=None):
            if 'b' not in mode and 'w' in mode and newline is None:
                newline = '\r\n'
            return original_open(path, mode, buffering, encoding, errors, newline)

        with tempfile.TemporaryDirectory() as temp, patch.object(Path, 'open', windows_open):
            data, run, _ = self.fixture(temp)
            manifest = freeze_enabled_methodologies(data, run, 'scene-run')
            item = manifest.enabled_user_methodologies[0]
            frozen_path = Path(item.path)
            frozen_bytes = frozen_path.read_bytes()
            self.assertIn('确认再次连接可恢复'.encode('utf-8'), frozen_bytes)
            self.assertNotIn(b'\r\n', frozen_bytes)
            self.assertEqual(sha256(frozen_bytes).hexdigest(), item.content_sha256)
            write_json(data / 'methodologies/registry.json', {'methodologies': []})
            self.assertEqual(freeze_enabled_methodologies(data, run, 'scene-run'), manifest)
            self.assertEqual(frozen_path.read_bytes(), frozen_bytes)
            frozen_path.write_bytes(frozen_bytes + b'tampered')
            with self.assertRaisesRegex(ValueError, 'Run 冻结方法论内容校验失败'):
                freeze_enabled_methodologies(data, run, 'scene-run')

    def fixture(self, directory, scene='branch-analysis', mode='speed', coverage=False, empty=False):
        root = Path(directory)
        data = root / 'data'
        repo = data / 'repositories' / 'sample'
        repo.mkdir(parents=True, exist_ok=True)
        (repo / 'tls.c').write_text('int connect_session(int ready) { if (!ready) return -1; return 0; }\n')
        contract = dict(data_root=str(data), run_id='scene-run', repository='sample', target='连接流程',
                        workflow_version='source-first-v1', analysis_profile='behavior-test-v2',
                        analysis_settings={'scenario': scene, 'mode': mode}, source_scope=['.'], asset_ids=[])
        if coverage:
            source = root / 'coverage.json'
            write_json(source, {'status': 'success', 'query_resolution': {'status': 'matched'},
                'uncovered_functions': [] if empty else [{'source': 'test-build', 'file_path': 'tls.c', 'uncovered_functions': ['connect_session']}]})
            asset = import_asset(str(data), str(source), 'coverage')
            prepare_asset_extraction(str(data), asset.asset_id)
            detail = asset_detail(str(data), asset.asset_id)['asset']
            contract.update(asset_ids=[asset.asset_id], asset_revisions={asset.asset_id: detail['input_revision']})
        write_json(data / 'methodologies/registry.json', {'methodologies': [{
            'methodology_id': 'tls-recovery', 'title': '连接恢复经验', 'status': 'enabled',
            'applicable_when': ['连接被拒绝'], 'checks': ['确认再次连接可恢复'],
            'expected_signals': ['再次连接成功'], 'failure_signals': ['持续拒绝'],
            'source_item_ids': ['synthetic-defect-1'],
            'created_at': '2026-09-22T00:00:00Z', 'updated_at': '2026-09-22T00:00:00Z'}]})
        request = root / 'request.json'
        write_json(request, contract)
        return data, data / 'runs' / 'scene-run', request

    def test_four_scenes_both_modes_complete_and_resume_frozen_rules(self):
        for scenario in SCENES:
            for mode in ['depth', 'speed']:
                with self.subTest(scenario=scenario, mode=mode), tempfile.TemporaryDirectory() as temp:
                    data, run, request = self.fixture(temp, scenario, mode, scenario == 'coverage-analysis')
                    first = run_module_analysis(str(request))
                    frozen = (run / 'inputs/analysis-scene.json').read_bytes()
                    plan_action = first['agent_actions'][0]
                    binding = (str(data), 'scene-run', plan_action['action_id'], 'planner-session')
                    bind_action(*binding)
                    saved = plan_write(*binding, expected_revision=0, unit={'title': '连接', 'purpose': '负责对象主干流程', 'methodology_ids': ['tls-recovery'], 'owned_files': [{'repo_id': 'sample', 'path': 'tls.c'}]})
                    work_finish(*binding, revision=saved['revision'])
                    advanced = settle_action(*binding[:3])
                    self.assertNotEqual(advanced.get('validation', {}).get('status'), 'invalid', advanced)
                    progress = read_json(run / 'progress.json')
                    analysis = next(a for a in progress['actions'].values() if a['role'] == 'analysis')
                    task = read_json(Path(analysis['task_path']))
                    self.assertEqual(task['scenario'], scenario)
                    self.assertIn('scene_common_generation.md', ' '.join(task['rubric_paths']))
                    self.assertNotIn('behavior_test_generation.md', ' '.join(task['rubric_paths']))
                    unit_id = task['unit_id']
                    first_result_path = Path(task['result_path'])
                    exercise_closure = scenario == 'branch-analysis' and mode == 'speed'
                    binding = (str(data), 'scene-run', analysis['action_id'], 'analysis-session')
                    bind_action(*binding)
                    selected = input_read(*binding, input_id='rubric_user_tls-recovery')
                    self.assertIn('确认再次连接可恢复', selected['text'])
                    opened = task_open(*binding)
                    self.assertEqual(opened['task']['scenario'], scenario)
                    self.assertNotIn('all_scope_paths', opened['task'])
                    saved = result_write(*binding, expected_revision=0, records=[
                        {'kind': 'flow', 'body': {'format_version': 'module-flow-text-v1', 'flow_id': 'F1', 'title': '连接流程', 'text': '入口→检查就绪；未就绪拒绝，否则建立连接。'}},
                        {'kind': 'summary', 'body': '合成样例：未确认产品风险，无新增补测。'}])
                    work_finish(*binding, revision=saved['revision'])
                    settle_action(*binding[:3])
                    first_result = first_result_path.read_bytes()
                    for _ in range(2 if mode == 'depth' else 1):
                        progress = read_json(run / 'progress.json')
                        review = next(a for a in progress['actions'].values() if a['role'] == 'review' and a['status'] == 'pending')
                        task = read_json(Path(review['task_path']))
                        self.assertEqual(task['scenario'], scenario)
                        self.assertIn('scene_common_review.md', ' '.join(task['rubric_paths']))
                        binding = (str(data), 'scene-run', review['action_id'], 'reviewer-session')
                        if review.get('task_id'): self.assertEqual(review['task_id'], binding[-1])
                        bind_action(*binding)
                        self.assertIn('确认再次连接可恢复', input_read(*binding, input_id='rubric_user_tls-recovery')['text'])
                        current = read_json(Path(task['result_path']))
                        if task.get('review_stage') == 'comparison_review':
                            if exercise_closure:
                                comparison_finding_write(*binding, expected_revision=current['revision'], unit_ids=[unit_id], finding={'summary': '补充拒绝后的恢复说明', 'body': '合成定向修正路由验收'})
                                current = read_json(Path(task['result_path']))
                            saved = review_decide(*binding, expected_revision=current['revision'], decision={'disposition': 'finding' if exercise_closure else 'pass', 'version_set_id': task['version_set_id'], 'correction_record_ids': [r['record_id'] for r in current['records'] if r['kind'] == 'finding'] if exercise_closure else [], 'summary': '合成路由验收，不代表模型质量验收'})
                        else:
                            saved = result_write(*binding, expected_revision=current['revision'], records=[{'kind': 'summary', 'body': '独立核实连接主干'}])
                        work_finish(*binding, revision=saved['revision'])
                        settle_action(*binding[:3])
                    if exercise_closure:
                        progress = read_json(run / 'progress.json')
                        closure = next(a for a in progress['actions'].values() if a['role'] == 'closure')
                        self.assertEqual(closure['task_id'], 'analysis-session')
                        task = read_json(Path(closure['task_path']))
                        self.assertEqual(task['scenario'], scenario)
                        binding = (str(data), 'scene-run', closure['action_id'], 'analysis-session')
                        bind_action(*binding)
                        self.assertIn('确认再次连接可恢复', input_read(*binding, input_id='rubric_user_tls-recovery')['text'])
                        current = read_json(Path(task['result_path']))
                        flow = next(r for r in current['records'] if r['kind'] == 'flow')
                        saved = result_supersede(*binding, expected_revision=current['revision'], target_record_ids=[flow['record_id']], replacement={'kind': 'flow', 'body': {**flow['body'], 'text': flow['body']['text'] + ' 修正后可再次发起连接。'}})
                        work_finish(*binding, revision=saved['revision'])
                        settle_action(*binding[:3])
                        self.assertEqual(first_result_path.read_bytes(), first_result)
                    progress = read_json(run / 'progress.json')
                    self.assertEqual(progress['lifecycle_status'], 'complete', progress)
                    report = (run / 'report.md').read_text()
                    self.assertIn('入口→检查就绪', report)
                    self.assertNotIn('.svg', report)
                    if scenario in {'branch-analysis', 'coverage-analysis'}:
                        self.assertNotIn('## 风险依据', report)
                        self.assertIn('本次未开展风险分析', report)
                    with patch('pangea_agent.analysis_scenarios.scene_spec', side_effect=AssertionError('must use frozen rules')), patch('pangea_agent.methodology.SPECIALIZED_METHODOLOGIES', {}):
                        resume_module_analysis('scene-run', str(data))
                    self.assertEqual((run / 'inputs/analysis-scene.json').read_bytes(), frozen)

    def test_coverage_missing_and_valid_empty_are_distinct(self):
        with tempfile.TemporaryDirectory() as temp:
            data, run, request = self.fixture(temp, 'coverage-analysis')
            with self.assertRaisesRegex(ValueError, 'COVERAGE_INPUT_REQUIRED'):
                run_module_analysis(str(request))
            self.assertFalse((run / 'progress.json').exists())
            self.assertTrue((run / 'inputs/preparation-error.json').exists())
        with tempfile.TemporaryDirectory() as temp:
            data, run, request = self.fixture(temp, 'coverage-analysis', coverage=True, empty=True)
            run_module_analysis(str(request))
            self.assertEqual(read_json(run / 'inputs/coverage-gaps.json'), [])
            self.assertEqual(read_json(run / 'inputs/coverage-match-summary.json')['sources'][0]['status'], 'success')

    def test_asset_content_revision_is_checked_without_changing_original(self):
        with tempfile.TemporaryDirectory() as temp:
            data, run, request = self.fixture(temp, coverage=True)
            c = read_json(request)
            detail = asset_detail(str(data), c['asset_ids'][0])
            path = Path(detail['asset']['result_path'])
            result = read_json(path)
            result['warnings'] = ['changed since selection']
            write_json(path, result)
            with self.assertRaisesRegex(ValueError, '资产输入已变更'):
                analysis_asset_inputs(str(data), c['asset_ids'], expected_revisions=c['asset_revisions'])
            self.assertEqual(read_json(path), result)

    def test_same_small_unit_prompt_does_not_expand_with_repository_file_count(self):
        lengths = []
        measurements = []
        for count in [16, 2000]:
            with tempfile.TemporaryDirectory() as temp:
                data, run, request = self.fixture(temp)
                repo = data / 'repositories/sample'
                for number in range(count - 1):
                    (repo / f'unrelated-{number:04}.c').write_text('int unrelated(void) { return 0; }')
                started = time.perf_counter()
                first = run_module_analysis(str(request))
                freeze_ms = round((time.perf_counter() - started) * 1000)
                action = first['agent_actions'][0]
                binding = (str(data), 'scene-run', action['action_id'], 'planner')
                bind_action(*binding)
                saved = plan_write(*binding, expected_revision=0, unit={'title': '连接', 'purpose': '主干流程', 'owned_files': [{'repo_id': 'sample', 'path': 'tls.c'}]})
                work_finish(*binding, revision=saved['revision'])
                settle_action(*binding[:3])
                action = next(a for a in read_json(run / 'progress.json')['actions'].values() if a['role'] == 'analysis')
                binding = (str(data), 'scene-run', action['action_id'], 'worker')
                bind_action(*binding)
                text = json.dumps(task_open(*binding), ensure_ascii=False)
                self.assertNotIn('unrelated-', text)
                self.assertLess(len(text), 12000)
                lengths.append(len(text))
                measurements.append({"files": count, "task_open_chars": len(text), "freeze_ms": freeze_ms})
        self.assertLess(abs(lengths[1] - lengths[0]), 100)
        print("Compact task measurements:", json.dumps(measurements))

    def test_old_profile_and_contract_defaults_do_not_acquire_v2(self):
        old = TaskContract(repository='sample', target='TLS').model_dump(exclude_none=True)
        self.assertNotIn('analysis_profile', old)
        self.assertNotIn('asset_revisions', old)
        with self.assertRaises(ValueError):
            TaskContract(repository='sample', target='TLS', workflow_version='source-first-v1', analysis_profile='behavior-test-v1', analysis_settings={'scenario': 'branch-analysis', 'mode': 'speed'})


if __name__ == '__main__':
    unittest.main(verbosity=2)
