"""Persistent quota request adapter. Invoke through submit.sh."""
import json
import os
from pathlib import Path
import subprocess
import sys


def submit(args):
    if len(args) != 4:
        print("invalid argument count", file=sys.stderr)
        return 2
    state_arg, label, limit, amount = args
    state = Path(state_arg)
    if not label or "\n" in label:
        print("invalid label", file=sys.stderr)
        return 2
    try:
        if state.exists():
            current = json.loads(state.read_text(encoding="utf-8"))
            used = current["used"]
            if type(used) is not int or used < 0:
                raise ValueError("invalid used amount")
        else:
            current = {"used": 0, "last_label": None}
            used = 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"state error: {error}", file=sys.stderr)
        return 4
    executable = Path(__file__).resolve().with_name("quota")
    try:
        result = subprocess.run([str(executable), limit, str(used), amount],
                                capture_output=True, text=True, timeout=2)
    except (OSError, subprocess.TimeoutExpired) as error:
        print(f"backend error: {error}", file=sys.stderr)
        return 4
    if result.returncode == 1:
        print(result.stdout.strip(), file=sys.stderr)
        return 1
    if result.returncode == 2:
        print("invalid quota input", file=sys.stderr)
        return 2
    if result.returncode != 0:
        print(f"unexpected backend status: {result.returncode}", file=sys.stderr)
        return 4
    try:
        remaining = int(result.stdout.strip().removeprefix("ACCEPT remaining="))
        updated = {"used": used + int(amount), "last_label": label}
        temporary = state.with_name(state.name + ".tmp")
        temporary.write_text(json.dumps(updated, ensure_ascii=False) + "\n", encoding="utf-8")
        os.replace(temporary, state)
    except (OSError, ValueError) as error:
        print(f"commit error: {error}", file=sys.stderr)
        return 4
    print(f"accepted label={label} remaining={remaining}")
    return 0


if __name__ == "__main__":
    sys.exit(submit(sys.argv[1:]))
