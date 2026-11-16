# Backend and portable updater implementation checkpoint — 2026-11-17

## Ownership and baseline

Task source: `/Volumes/Media/pangea-desktop/.pangea-build/TASK-FOR-GPT.md`.
Desktop worktree: `/Volumes/Media/pangea-backend-20261117`, branch `codex/backend-updater-20261117`, base `ef8963a`.
Agent worktree: `/Volumes/Media/pangea-agent-backend-20261117`, branch `codex/backend-contracts-20261117`, base `390aa7d` (the current component pin).
Original dirty worktrees, user profiles, Runs, reports and Git configuration are not modified. No forbidden plugin frontend file is edited. No component pin is advanced to an uncommitted/nonexistent commit.

## Implemented candidate

### Updater

Replace one PowerShell process plus C# compilation per directory scan with a resident diagnostic worker, owned by a kill-on-close Windows Job. It waits for its first pipe request before compilation. Base64 UTF-8 JSON lines preserve literal Unicode paths independent of Windows console code pages. Sequence numbers reject stale responses. Timeouts and errors dispose the worker; subsequent requests create a new one. Final cleanup closes the owned job.

Fresh directory scans, service policy checks, PID + creation-time verification, protected processes, Explorer recovery, signature checks, extraction paths, data-copy checks and rollback behavior are preserved. This removes repeated process/compilation overhead, **not** the O(N) repeated handle-table enumeration or CIM queries. No sub-minute upgrade claim is made.

Restart Manager cannot be a drop-in directory scanner: Microsoft documents `ERROR_ACCESS_DENIED` for a registered directory in `RmGetList`:
https://learn.microsoft.com/en-us/windows/win32/api/restartmanager/nf-restartmanager-rmgetlist
A future fast path may register known file resources, but an empty result cannot certify absence of CWD/directory holders.

### Agent

New scene snapshots freeze `instrumentation-readiness-v1` and `source-facts-v1`. Explicit internal-injection wording combined with ready emits a field-level advisory, never a semantic reclassification. Generation instructions explain external reproducibility, instrumentation points and unknown conditions. Existing evidence resolver validates declared frozen-source paths/line ranges and explicit repo/path/symbol tuples. Textual symbol presence is not a definition/call-graph proof. Warnings bind to exact records/revisions and retire on explicit supersession; history remains available. Existing Runs do not receive new contracts.

This is a partial task-three/task-four implementation. No new reviewer, falsifier dispatch or cross-unit reconciliation is installed. Static source checks are advisory; no <1 second whole-Run guarantee is established. Semantic risk grading remains worker-owned.

## Task two: already fixed in current mainline

The component lock is companion `64aa49bba9d70dd026d23f50612218683f2454aa`. Both Git wrappers call `withGitLongPaths` from `src/repositories/git-environment.js` at this exact commit. Existing committed evidence under `windows-compatibility-post-merge-20261116` contains all four passing native source/package false/true-default reports, including negative controls and unchanged configuration. See `2026-11-16-windows-compatibility-post-merge.md` for runs 43898666192 / 43898667767.

These are previously recorded Windows results, inspected in this task, not fresh Windows executions of the updater candidate.

## Validation actually performed

- PowerShell 7.4.6 on macOS: updater and native test script parse successfully.
- New real-process pipe test: resident reuse, literal Unicode paths, timeout termination, fresh worker after timeout, scan failure fail-closed all pass. Scan implementation and Windows Job boundary are fixtures here.
- Existing batch cleanup script: all assertions pass, including released/reused PID, executable/service/user/session/critical-policy changes, unknown processes, Explorer recovery and bounded retries. This is a policy simulation.
- Desktop Vitest: 7 files / 39 tests passed (portable manifest/signature, patch, recovery, admission, health, handoff, file I/O).
- Desktop TypeScript check passed (`tsc --noEmit -p tsconfig.node.json`).
- Agent new diagnostics/store integration: 12 passed; compileall passed.
- Borrowed older store regression suite: 7 passed / 1 failed. The identical compact legacy page-token failure reproduces against unmodified pinned `390aa7d`; it is not repaired or suppressed by this change.
- Windows native test is extended to assert helper PID reuse and to clean the resident worker. New pipe suite is included in Windows PowerShell 5.1 CI. These new native tests have not run yet.

## Remaining architecture work and acceptance gates

### Phase A hard links

Only reuse bytes after validating the installed source against the signed target manifest; changed/new files must use create-new storage, never truncate a shared link. Link failure may fall back to a verified copy, but access errors, unexpected destination files and reparse paths must not be disguised as success. Preserve content validation; eliminating duplicate byte writes is not permission to trust stale manifests.

Before default activation, establish which installation files can be written by startup/plugin installation/Python caches. NTFS hard links share writes and metadata: a post-switch in-place write can corrupt the rollback copy even when patch application itself never overwrites an unchanged file. A verified immutable set or separation of every mutable runtime output is required. This candidate does not activate hard links.

### Phase A user data

Use an externally owned persistent directory and an explicit durable migration receipt. Record migration intent before moving either launch-root or local-skills. Recovery must recognize source-only, target-only, both and neither states by ownership/identity; it must never overwrite an unexpected directory. Every state transition requires crash/termination tests. Preserve existing absolute repository paths and old-version access during rollback. A plain Copy-to-Move replacement is insufficient. This candidate leaves existing preservation unchanged.

### Phase B launcher

A stable launcher resolves a validated relative version identifier in an atomically replaced activation record, with app versions in app-<version>/ and mutable state in data/. Download/signature verification/build occurs before restart. The launcher retains previous activation until PID/version/nonce health confirmation. Startup failure or interrupted activation selects the prior complete version; cleanup removes only inactive, transaction-owned app directories, never data. Recovery and old-package migration require a versioned protocol, not opportunistic junction replacement.

### Narrow risk falsifier and cross-unit reconciliation

Freeze an explicit contract only for new Runs. Select High/Critical records by declared severity, retain original record/revision, and dispatch one bounded caller investigation (1–2 levels) using frozen source access. Evidence-backed corrections may reduce severity/add exclusion conditions; absent evidence preserves the original risk and labels unresolved reachability. No inferred call graph, automatic severity rewrite, unrelated case rewrite or repeated closure loop. The host must bind the investigation to exact action/task/result identities.

At aggregation, reconcile explicit interface identities and producer/consumer error-code assumptions from the frozen unit set. Text similarity is not identity or contradiction proof. Nonmatching assumptions produce targeted evidence requests, not fabricated new risks. Both mechanisms remain design-only in this checkpoint.

### Native performance acceptance

Measure 100,000-file trees plus >=1 GiB launch-root on NTFS, baseline versus candidate, recording process starts, compilation count, handle scans, hashes, copied/linked bytes, switch duration and rollback duration. Exercise locked directory/CWD, stopped/reused PIDs, low space, link failures, corrupted manifests, concurrent user-data writer, every transaction crash boundary and startup failure. Local pipe tests are not substitutes for these measurements.

No commits, pushes, merges, signed package modifications or releases have been performed at this checkpoint. Native CI needs explicit commit/push authorization under the project rules.
