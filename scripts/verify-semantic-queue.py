"""Compile an independent oracle; never edit the source fixture or a Run.

Only mq.c/mq.h and design.md are analysis inputs. oracle.c and this runner
belong to acceptance, and must not be exposed to the analyzing model.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cc', default='cc')
    args = parser.parse_args()
    source = Path(__file__).parent / 'fixtures/semantic-queue'
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in source.iterdir() if p.is_file()}
    results = []
    original = (source / 'mq.c').read_text(encoding='utf-8')
    assert original.count('offset > q->count') == 1
    with tempfile.TemporaryDirectory(prefix='pangea-semantic-oracle-') as temporary:
        root = Path(temporary)
        for name in ('mq.h', 'oracle.c'):
            shutil.copy2(source / name, root / name)
        for variant in ('original', 'peek-boundary-only'):
            code = original if variant == 'original' else original.replace('offset > q->count', 'offset >= q->count')
            (root / 'mq.c').write_text(code, encoding='utf-8')
            executable = root / 'oracle.exe'
            command = [args.cc, '-std=c11', '-Wall', '-Wextra', '-Werror', str(root / 'mq.c'), str(root / 'oracle.c'), '-o', str(executable)]
            subprocess.run(command, check=True, capture_output=True, text=True)
            result = subprocess.run([str(executable)], capture_output=True, text=True)
            expected = 1 if variant == 'original' else 0
            assert result.returncode == expected, (variant, result.returncode, result.stdout, result.stderr)
            results.append({'variant': variant, 'exit_code': result.returncode, 'stdout': result.stdout.strip()})
    assert hashes == {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in source.iterdir() if p.is_file()}
    print(json.dumps({'fixture_source_unchanged': True, 'source_hashes': hashes, 'results': results, 'coverage_source': 'independent compiled C oracle; synthetic XLSX is not execution evidence'}, indent=2))


if __name__ == '__main__':
    main()
