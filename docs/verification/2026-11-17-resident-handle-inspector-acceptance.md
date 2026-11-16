# Resident handle inspector — native Windows acceptance

Date: 2026-11-17 (Asia/Shanghai).

The independently pushed branch `codex/backend-updater-20261117` passed all three jobs in
[run 43912637060](https://github.com/CyberShp/pangea-desktop/actions/runs/43912637060)
at tested commit `051bfea2fbbfa60bef27051a347df40babbe74be`.
The later acceptance-document commit does not alter runtime or tests. No merge or release was performed.

## Change and native evidence

The updater reuses a job-owned diagnostic PowerShell process instead of starting and compiling
one for each scan. Every pre-termination holder scan, identity check and policy recheck remains.
The scanner works from the system directory, not the update workspace, and cleanup waits for exit.
UTF-8 JSON is transported as Base64 lines through explicitly decoded pipes.

Windows Server 2022 / Windows PowerShell 5.1 assertions passed for:

- Real zero/one/multiple directory holders, reuse of the same helper PID and removal of the
  disposable control directory while the helper remains running.
- Protocol BOM/code-page handling, Unicode/bracket paths, timeout termination, fresh worker
  after timeout and propagation of native scan errors. The protocol suite uses a scan fixture;
  the separate holder suite uses real Windows kernel handles and real disposable processes.
- Existing PID creation-time, protected-process, service/user/session and Explorer-recovery policies.
- Actual process interruption at nine transaction checkpoints, rollback recovery and retained data.
- User-data copy/change detection, profile rollback, long paths, package hash/size rejection,
  path traversal rejection, startup health identity and progress ownership.

The real holder suite used one helper for eight fresh scans. Recorded durations were
807, 112, 93, 81, 81, 78, 80 and 78 ms. The first includes startup/compilation; subsequent
scans were 78–112 ms. This is a small fixture, not a before/after installation benchmark.
The number of handle-table scans and CIM queries has not been reduced.

## Other regression results

- `tooling`: success; Node release-tool suites 164 passed / 15 skipped / 0 failed;
  Vitest groups 74 + 14 + 37 passed.
- `windows-updater`: success; assertion excerpts retained below.
- `windows-components`: success; plugin suites 45 passed, companion 1064 passed / 32 skipped,
  asset catalog 119 passed / 1 skipped, ACP adapter delivery 6 passed. Skips are not passes.
- Native source HTTP compatibility passed with isolated global `core.longpaths=false` and
  `true`, using Git 2.56.1.windows.1. Disabled-default includes the failing unfixed negative
  control; original configuration remains unchanged.

`build_unsigned=false`: this run did not build or test a new win-unpacked instance.
The earlier packaged compatibility evidence remains separate and is not claimed as a
new packaged acceptance of this updater.

## Failed attempts and corrections

| Run | Result and correction |
| --- | --- |
| [43910166450](https://github.com/CyberShp/pangea-desktop/actions/runs/43910166450) | Failed on the first native scan; the wrapper had masked the helper error. Preserved the underlying diagnostic. |
| [43910682425](https://github.com/CyberShp/pangea-desktop/actions/runs/43910682425) | Reported invalid Base64 from stdin. A BOM/code-page fixture reproduced the failure locally; an explicit pipe reader and byte-oriented requests fixed it. |
| [43911323306](https://github.com/CyberShp/pangea-desktop/actions/runs/43911323306) | Scan and copy passed; test cleanup failed because the resident helper pinned its working directory. Moved helper CWD to the system directory and added exit waiting/native removal verification. |
| [43911985268](https://github.com/CyberShp/pangea-desktop/actions/runs/43911985268) | Prior failures passed; the added test fixture injected a second BOM on Framework. Corrected fixture injection to account for the native preamble, retaining all protocol assertions. |
| [43912637060](https://github.com/CyberShp/pangea-desktop/actions/runs/43912637060) | All three jobs passed. Native fixture confirmed UTF-8 with a three-byte preamble. |

The Framework behavior is documented directly in Microsoft's
[Process implementation](https://github.com/Microsoft/referencesource/blob/main/System/services/monitoring/system/diagnosticts/Process.cs)
and [StreamWriter implementation](https://github.com/Microsoft/referencesource/blob/main/mscorlib/system/io/streamwriter.cs):
redirected stdin enables AutoFlush, which emits the encoding preamble.
The local mutation restoring Console.ReadLine failed the same BOM fixture; the fixed reader passed.

## Durable evidence and remaining work

- [CI summary](backend-updater-20261117/ci-summary.json)
- [Updater assertion excerpts](backend-updater-20261117/updater-assertions.txt)
- [Source / disabled-default](backend-updater-20261117/fault-injection-source.json)
- [Source / enabled-default](backend-updater-20261117/fault-injection-source-enabled.json)
- [Architecture plan and remaining scope](2026-11-17-backend-updater-plan.md)

Hard-link reconstruction, user-data relocation, the thin launcher, large-tree/GB-data
upgrade performance, and the complete Agent falsifier/reconciliation pipeline remain unfinished.
Agent changes are local and uncommitted; the component lock is unchanged. This acceptance covers
the resident inspector increment, not completion of the entire backend task list.
