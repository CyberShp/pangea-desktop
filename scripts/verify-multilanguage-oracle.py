"""Independent executable oracle for the isolated mixed-language fixture.

Runs public entry points, records actual stdout/stderr/status/state, and keeps
known defect expectations outside the source supplied to the analysis model.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import sys


def run_oracle(source, output, python):
    output.mkdir(parents=True, exist_ok=False)
    rows = []
    definitions = [
        ('admit', 'alpha', '10', '3', None, 0, {'used': 3, 'last_label': 'alpha'}, None),
        ('deny', 'alpha', '10', '4', {'used': 7, 'last_label': 'prior'}, 1, None, 'DENIED remaining=3'),
        ('label-space', 'alpha beta', '10', '3', None, 0, {'used': 3, 'last_label': 'alpha beta'}, None),
        ('label-glob', '*', '10', '3', None, 0, {'used': 3, 'last_label': '*'}, None),
        ('invalid-limit-suffix', 'alpha', '10junk', '3', None, 2, None, 'invalid'),
        ('invalid-amount-suffix', 'alpha', '10', '3junk', None, 2, None, 'invalid'),
        ('invalid-plus', 'alpha', '+10', '3', None, 2, None, 'invalid'),
        ('invalid-leading-space', 'alpha', ' 10', '3', None, 2, None, 'invalid'),
        ('invalid-amount-underscore', 'alpha', '100', '1_000', None, 2, None, 'invalid'),
        ('invalid-amount-underscore-consistency', 'alpha', '100', '1_0', None, 2, None, 'invalid'),
        ('negative', 'alpha', '10', '-1', None, 2, None, 'invalid'),
        ('zero', 'alpha', '10', '0', None, 2, None, 'invalid'),
        ('state-over-limit', 'alpha', '10', '1', {'used': 11, 'last_label': 'prior'}, 2, None, 'invalid'),
        ('malformed-state', 'alpha', '10', '1', '{bad json', 4, None, 'state error'),
        ('missing-backend', 'alpha', '10', '1', None, 4, None, 'backend error'),
        ('state-path-space', 'alpha', '10', '3', None, 0, {'used': 3, 'last_label': 'alpha'}, None),
        ('foreign-cwd', 'alpha', '10', '3', None, 0, {'used': 3, 'last_label': 'alpha'}, None),
    ]
    with tempfile.TemporaryDirectory(prefix='pangea-mixed-oracle-') as temp:
        temp = Path(temp)
        interpreter_bin = temp / 'bin'
        interpreter_bin.mkdir()
        (interpreter_bin / 'python3').symlink_to(python)
        env = dict(os.environ, PATH=str(interpreter_bin) + os.pathsep + os.environ.get('PATH', ''))
        python_version = subprocess.check_output(['python3', '--version'], env=env, text=True).strip()
        version = json.loads(subprocess.check_output(
            ['python3', '-c', 'import json, sys; print(json.dumps(list(sys.version_info[:2])))'], env=env, text=True))
        if tuple(version) < (3, 10):
            raise RuntimeError(f'Fixture requires Python 3.10+, got {python_version}; use --python')
        for interpreter in ['sh', 'bash']:
            for name, label, limit, amount, initial, expected_rc, expected_state, stderr_token in definitions:
                root = temp / (interpreter + '-' + name)
                shutil.copytree(source, root)
                build = subprocess.run(['cc', '-std=c11', '-Wall', '-Wextra', str(root / 'quota.c'), '-o', str(root / 'quota')], capture_output=True, text=True)
                assert build.returncode == 0, build.stderr
                state = root / ('state with space.json' if name == 'state-path-space' else 'state.json')
                if initial is not None:
                    state.write_text(initial if isinstance(initial, str) else json.dumps(initial))
                before = state.read_bytes() if state.exists() else None
                if name == 'missing-backend':
                    (root / 'quota').rename(root / 'quota-unavailable')
                args = [interpreter, str(root / 'submit.sh'), str(state), label, limit, amount]
                completed = subprocess.run(args, cwd=temp if name == 'foreign-cwd' else root, env=env, capture_output=True, text=True, timeout=10)
                after = state.read_bytes() if state.exists() else None
                state_ok = after == before if expected_state is None else after is not None and json.loads(after) == expected_state
                observations = dict(exit_code=completed.returncode == expected_rc,
                                    state=state_ok,
                                    diagnostic=(stderr_token is None or stderr_token.lower() in completed.stderr.lower()),
                                    success_output=(expected_rc != 0 or 'accepted label=' in completed.stdout))
                rows.append(dict(case=name, interpreter=interpreter, argv=[interpreter,'submit.sh','STATE',label,limit,amount],
                                 expected_exit=expected_rc, actual_exit=completed.returncode,
                                 stdout=completed.stdout, stderr=completed.stderr,
                                 state_before=before.decode() if before else None,
                                 state_after=after.decode() if after else None,
                                 assertions=observations, contract_pass=all(observations.values())))
        recovery = []
        for interpreter in ['sh', 'bash']:
            root = temp / (interpreter + '-underscore-recovery')
            shutil.copytree(source, root)
            subprocess.run(['cc', '-std=c11', str(root/'quota.c'), '-o', str(root/'quota')], check=True)
            state = root/'state.json'
            attempts = []
            for amount, expected_rc, expected_state in [('1_000', 2, None), ('1', 0, {'used': 1, 'last_label': 'alpha'})]:
                proc = subprocess.run([interpreter, str(root/'submit.sh'), str(state), 'alpha', '100', amount],
                                      cwd=root, env=env, capture_output=True, text=True, timeout=10)
                actual_state = json.loads(state.read_text()) if state.exists() else None
                attempts.append(dict(amount=amount, expected_exit=expected_rc, actual_exit=proc.returncode,
                                     expected_state=expected_state, actual_state=actual_state,
                                     stdout=proc.stdout, stderr=proc.stderr,
                                     contract_pass=proc.returncode == expected_rc and actual_state == expected_state))
            recovery.append(dict(interpreter=interpreter, attempts=attempts, contract_pass=all(a['contract_pass'] for a in attempts)))
        # Direct backend probes isolate C numeric parsing from launcher error masking.
        root = temp / 'backend'
        shutil.copytree(source, root)
        subprocess.run(['cc', '-std=c11', str(root/'quota.c'), '-o',str(root/'quota')],check=True)
        backend = []
        for args, expected in [(['10','0','3'],0), (['10','7','4'],1), (['10junk','0','3'],2), (['10','0','3junk'],2), (['+10','0','3'],2), ([' 10','0','3'],2)]:
            proc=subprocess.run([str(root/'quota'),*args],capture_output=True,text=True)
            backend.append(dict(argv=args,expected_exit=expected,actual_exit=proc.returncode,stdout=proc.stdout,contract_pass=proc.returncode==expected))
    result = {'fixture_source':str(source.resolve()), 'python': str(python), 'python_version': python_version, 'public_cases':rows,'backend_cases':backend,
              'recovery_cases': recovery, 'recovery_passed': sum(r['contract_pass'] for r in recovery), 'recovery_total': len(recovery),
              'public_passed':sum(r['contract_pass'] for r in rows),'public_total':len(rows),
              'backend_passed':sum(r['contract_pass'] for r in backend),'backend_total':len(backend),
              'note':'Seeded subject defects are expected; these are observations, not scanner regressions.'}
    (output/'oracle.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({key:result[key] for key in ['public_passed','public_total','backend_passed','backend_total']}))
    return result


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--python',type=Path,default=Path(sys.executable))
    parser.add_argument('--require-pass', action='store_true', help='Exit nonzero unless all fixture contracts and recovery sequences pass')
    args=parser.parse_args()
    result = run_oracle(args.source,args.output,args.python.absolute())
    if args.require_pass and any(result[f'{group}_passed'] != result[f'{group}_total'] for group in ['public', 'backend', 'recovery']):
        raise SystemExit(1)
