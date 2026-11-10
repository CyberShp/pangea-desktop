# Quota request application

Build on macOS/Linux with Python 3.10+ and a C compiler:

    cc -std=c11 -Wall -Wextra quota.c -o quota

Public entry point (arguments must be passed literally):

    sh submit.sh STATE_FILE LABEL LIMIT AMOUNT

The launcher may be invoked from any working directory. LABEL is a single, nonempty string without newline; spaces and glob characters are supported and must be preserved literally. STATE_FILE may contain spaces. No environment variable selects a different backend. The packaged quota executable is built from quota.c and is always next to bridge.py. No network, plugin loader, FFI or alternative backend exists.

LIMIT and AMOUNT must be unsigned ASCII decimal strings with at least one digit, no whitespace, signs or trailing characters, and fit the target C long. AMOUNT must be positive. Existing state's used value must be nonnegative and not greater than LIMIT. Inputs outside this contract must be rejected, not partially parsed.

The state JSON is {"used": integer, "last_label": string or null}. A nonexistent file starts at used=0. Successful admission adds AMOUNT to used, preserves LABEL as last_label and writes the state atomically. Requests run serially; concurrent writers and external symlink races are outside the supported contract. The state file's parent directory must already exist and be writable. Failed requests must leave existing state bytes unchanged and must not create an initial state file.

Public exit contract:
- 0: admitted, stdout contains "accepted label=... remaining=...".
- 1: quota denied, stderr contains "DENIED remaining=...".
- 2: invalid arguments or numeric input, stderr diagnostic.
- 4: unreadable/malformed state, missing backend, backend timeout, unexpected backend failure, or commit failure, stderr diagnostic.

C backend exit codes are 0/1/2 for accepted/denied/invalid. Its output protocol is respectively "ACCEPT remaining=N", "DENIED remaining=N", "INVALID". bridge.py handles state and transforms this into the public contract. The public process must preserve failure status; a finished invocation alone is not evidence of admission. Recovery means retrying a valid request after correcting the external input or restoring the executable/state environment.
