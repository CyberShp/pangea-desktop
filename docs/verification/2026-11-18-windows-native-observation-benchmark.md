# Native Windows syntax, launcher DLL observation and 100k benchmark

## Scope and revisions

On 2026-11-18, native Windows validation completed for:
- All 31 Git-tracked PowerShell files, recursively.
- Production desktop/recovery launcher and health checks under isolated TEMP/TMP.
- 100,000 unchanged package files and 1 GiB user data, including the complete supervisor.

Observation implementation: Desktop `391ade43775ca2c0df69f3f059c5b9b915e0c057`.
[Observation run](https://github.com/CyberShp/pangea-desktop/actions/runs/44320351236)
passed. [Benchmark run](https://github.com/CyberShp/pangea-desktop/actions/runs/44319886957)
ran at `bb44c0d4155d85d17b97f5bf9f831f9fb807e32c`; the production updater,
benchmark and lifecycle scripts are byte-identical between these revisions.
This change adds acceptance gates and a precompiled-fixture option to the
launcher regression; it does not modify production updater behavior.

## PowerShell 5.1 scan

Windows PowerShell **5.1.20348.5773**, Desktop edition, parsed all **31** tracked
.ps1/.psm1/.psd1 files. All had UTF-8 BOM and zero parser errors.
The [file-by-file report](windows-native-acceptance-20261118/portable-ps51-ast.json)
contains SHA-256 values and parser results. Untracked user output/dependency
directories are outside the source inventory. This parses scripts without
executing their application actions.

## Temporary DLL observation

A fresh PS 5.1 child runs the production launcher regression with TEMP and TMP
redirected to an empty owned directory. A FileSystemWatcher captures created
and renamed *.dll recursively; watcher overflow/errors invalidate acceptance.
The native application fixture is compiled before this observation window.

The positive control detected both an actual Add-Type temporary compiler DLL
and a created-then-deleted DLL. No DLL remained afterward, demonstrating why
a final directory listing alone is insufficient.
The launcher regression produced **zero DLL events and zero remaining DLLs**,
with no watcher errors, and completed nine reported checks: launch failure,
literal bracket/Chinese paths, clean inherited environment, redirected logs,
healthy PID/version/time identity, early exit, wrong health fields, and missing
marker timeout/progress behavior.

See [raw observation](windows-native-acceptance-20261118/portable-launch-temp-dll.json).
This closes the scoped launcher DLL observation only. Other production helpers
still use Add-Type. It does not prove a global updater zero-DLL property,
antivirus compatibility, or real Electron GUI behavior.

## 100,000-file / 1 GiB benchmark

Windows NT 10.0.26100.0, PowerShell **5.1.26100.33648**, native NTFS fixtures.

| Measured operation | Seconds |
| --- | ---: |
| Copy reconstruction | 84.421 |
| Data copy plus five fingerprints | 5.174 |
| Copy control subtotal | 89.595 |
| Verified hardlink reconstruction | 50.324 |
| Persistent data migration | 0.174 |
| Directory switch | 0.180 |
| Hardlink/migration/switch subtotal | 50.678 |
| Recovery rollback | 0.271 |
| Complete supervisor including workers, native health and cleanup | **127.942** |

The component subtotal is 43.4% lower than the sequential copy control.
The complete supervisor **does not meet the historical under-60-second target**.
This remains an unresolved performance gap, not a successful end-to-end timing
claim. Logs locate about 87.9 seconds in the patch worker and 26.5 seconds from
cleanup-worker start to supervisor exit; these elapsed intervals are not CPU
profiles or proof of a specific code regression. The fixture substitutes the
UI monitor and uses a native executable, not Electron. It runs sequentially on
one hosted runner, without randomized cold-cache or antivirus controls.

The control copied 100,000 unchanged files; the candidate linked all 100,000,
copied zero, and applied one payload. The complete supervisor fixture adds
three package entries (100,003 total), links 100,002 and applies one payload.
1 GiB bytes, directory identities, retained new edits and expected program
versions passed validation. No-lock measurements made zero handle scans or
handle-worker starts. Nine crash boundaries and healthy/failed-start lifecycle
checks also passed. Functional/data assertions passed independently of the
unmet full-supervisor time target.

Evidence:
- [Component benchmark](windows-native-acceptance-20261118/portable-zero-copy-benchmark.json)
- [Complete supervisor](windows-native-acceptance-20261118/portable-zero-copy-whole-supervisor.json)
- [Crash recovery](windows-native-acceptance-20261118/portable-zero-copy-crashes.json)
- [Small lifecycle fixture](windows-native-acceptance-20261118/portable-zero-copy-lifecycle.json)

## Regression and remaining limits

Local dependency drift was found: the isolated node_modules copy lacked a
tracked recovery-fence diagnostic patch. Reinstalling the lockfile and applying
tracked patches restored the regression without changing product source or
assertions: 20 tests passed, 1 Windows-only test skipped on macOS; the release
BOM check passed separately. Native Windows runs provide the platform evidence.

[Post-push pipeline](https://github.com/CyberShp/pangea-desktop/actions/runs/44320934421)
and [portable updater regression](https://github.com/CyberShp/pangea-desktop/actions/runs/44320934602)
both completed successfully on the integration revision (six pipeline jobs and one updater job).

Still open: complete supervisor below 60 seconds; real Electron/Windows Terminal
lock/upgrade/rollback combination; antivirus observations; global updater
temporary-DLL behavior; real GUI/manual acceptance and live-model quality.
No release or signing was performed. Original workspaces and user data remain preserved.
