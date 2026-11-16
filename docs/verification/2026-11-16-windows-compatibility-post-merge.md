# Windows compatibility acceptance after merging into langgraph

## Integrated revisions

- Companion merge: `d238b64ddcd0b22ca774dc5a75fa97e9450deccc`, combining mainline
  `29844736a4a72636038b9db6865f6a7e5aaadc2c` with the tested longpaths changes.
- Desktop merge: `10649deccc3a3a6803d884057dc9736f70e14c5c`, combining mainline
  `4e56bb81f14d21ef9ab23fe86c65939f2f638fec` with the compatibility delivery gates.
- Follow-up companion correction: `64aa49bba9d70dd026d23f50612218683f2454aa`.
- Final Desktop component pin: `251a9eb6b7b0981d6d03d1f48c2f6c4d77ae7be6`.

The Git wrapper merge retains mainline cancellation signals and extended LFS
operation timeouts while adding per-process temporary longpaths configuration.
The workflow merge retains the existing shipped-ACP-adapter delivery check and
adds the source/packaged compatibility gates. No build-trigger file was changed;
no release workflow was dispatched. All changes were integrated from isolated
worktrees, preserving the original user's workspace.

## Post-merge finding and correction

The initial mainline push check
[43897053556](https://github.com/CyberShp/pangea-desktop/actions/runs/43897053556)
failed the immediate repeat-push HTTP assertion with status 409 instead of 200.
The parallel assembly run `43897053598` was cancelled after the corrected
component pin superseded it; it is not counted as acceptance evidence.
The task file could advertise `ready` or `pushed` before its operation released
its locks. A deterministic cleanup barrier reproduced the premature `pushed`
response locally. The correction keeps reads in `generating` or `pushing` until
cleanup actually finishes; concurrent mutations still receive 409. Once terminal
status is visible, repeat push remains idempotent. Both generation and push now
have barrier-based HTTP regression checks; no timing luck is required to enter
the race window.

The pre-merge mainline run
[43893452623](https://github.com/CyberShp/pangea-desktop/actions/runs/43893452623)
also exposed overly short fixture polling limits (HTTP completion and worker
progress). These assertions now wait for observable state with bounded 30-second
and 10-second deadlines respectively. Concurrency, ordering, remote SHA and
idempotency assertions remain intact; production timeouts were not increased.

## Local validation

- Initial merge: 60 targeted plugin tests, 1 repository-operation cancellation/lock
  test, 6 shipped ACP delivery tests, and 10 staging/delivery-gate tests passed.
- HTTP longpaths/content/recovery verifier passed before and after the follow-up.
- Follow-up HTTP/service/ACP tests: 97 passed, 8 existing skips, 0 failed.
- Final deterministic HTTP suite: 10 passed, 0 failed.

## Native acceptance

Both final mainline workflows completed successfully at Desktop
`251a9eb6b7b0981d6d03d1f48c2f6c4d77ae7be6`, locking companion
`64aa49bba9d70dd026d23f50612218683f2454aa`:

- [Automatic mainline regression 43898666192](https://github.com/CyberShp/pangea-desktop/actions/runs/43898666192)
- [Fresh unsigned assembly and acceptance 43898667767](https://github.com/CyberShp/pangea-desktop/actions/runs/43898667767)

All tooling, Windows updater and Windows component jobs passed in both runs.

| Target | Isolated global `core.longpaths` | Result |
| --- | --- | --- |
| Merged source | false | PASS, including failing unfixed negative control |
| Merged source | true | PASS |
| Newly assembled packaged Node + companion | false | PASS, including failing unfixed negative control |
| Newly assembled packaged Node + companion | true | PASS |

Environment: Windows Server 2022, Node 24.9.0, Git 2.56.1.windows.1. Checkout roots
are 174 characters; tracked file paths are 489 characters. The four runtime source
hashes match across all four assembly-run reports and both automatic-run reports.
The checks include 212 CRLF-only files, real edits, BOM/binary/invalid UTF-8 changes,
HTTP generation, failure and recovery, unchanged source snapshots and Git config.
User Git configuration is not modified.

The complete plugin suites passed before assembly and again during assembly:
45 dsh-pangea tests, 1064 companion tests (32 existing skips), 119 asset-catalog
tests (1 existing skip). The shipped ACP adapter delivery suite passed all 6 tests.
Typecheck, Electron build and 218 focused Desktop tests passed. Existing skips
are not counted as passes.

[Unsigned mainline Windows test instance](https://github.com/CyberShp/pangea-desktop/actions/runs/43898667767/artifacts/14240128939)
is retained for seven days. Extract the complete artifact and launch
`PANGEA Desktop.exe`; the adjacent resources must remain with it. This is a test
instance, not a published release or a replacement of an existing signed package.

Durable evidence:

- [Source / disabled](windows-compatibility-post-merge-20261116/fault-injection-source.json)
- [Source / enabled](windows-compatibility-post-merge-20261116/fault-injection-source-enabled.json)
- [Package / disabled](windows-compatibility-post-merge-20261116/fault-injection-packaged.json)
- [Package / enabled](windows-compatibility-post-merge-20261116/fault-injection-packaged-enabled.json)

Model output and analysis projection are fixtures; Git, filesystem, HTTP routes
and packaged runtime are real. This does not claim interactive UI or real-model
acceptance, nor validation of every Windows/Git version. Changes are merged into
both repositories' `langgraph` branch. No release was published. The subsequent
evidence-only documentation commit does not change the verified runtime or lock.
