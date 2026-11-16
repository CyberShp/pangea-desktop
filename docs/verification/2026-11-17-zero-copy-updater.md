# Windows portable updater: hard links and persistent user data

## Implementation and ownership

Candidate branch: `codex/backend-updater-20261117`. This is a test candidate, not a merge or release. The existing source worktree, plugin frontend, real profiles and Runs are untouched.

The earlier `2026-11-17-backend-updater-plan.md` is a historical checkpoint. This document supersedes its phase-A implementation status. Resident-handle acceptance remains recorded separately.

### Package reconstruction

`Apply-VerifiedPatch` verifies each unchanged source file's length and SHA-256 against the target manifest before `CreateHardLinkW`. The read handle excludes concurrent writes/deletion during verification/link creation. Source and destination ancestor reparse points are rejected. Changed/new payload entries are extracted into new files and verified. Every updater write/copy destination uses create-new/no-overwrite semantics, so a payload cannot truncate an existing link to rollback bytes.

Only unsupported-link, cross-volume and link-count-limit errors fall back to copy plus verification. Existing destinations, access errors and unexpected filesystem objects fail visibly. Existing signature admission, archive hash checks, relative-path validation and process identity checks remain in place.

Hard links share file contents and metadata. The reuse contract is **package-owned application files**, not arbitrary writable data. Current runtime writes are separated: `ensurePangeaWorkspace` copies bundled runtime material into `launch-root`; plugin installs run in the profile with `DSH_HOME`; local skills have their own root. The package builder excludes `__pycache__`. Updater create-new protection does not turn NTFS into copy-on-write or protect against unrelated software deliberately editing installed program files in place. Such editing is outside the supported package contract and must not be claimed safe by this candidate.

### User data

For each installation, the existing canonical transaction key selects a sibling `pangea-data-<key>/`. It contains the original `launch-root` and `local-skills` directory objects, moved on the same volume with no copy fallback. The receipt adjacent to the transaction journal records the installation, current user identity and each directory's NTFS volume/file ID before the first move. A write-through temporary file is flushed and atomically installed as the receipt.

Both application versions expose the original paths through managed directory junctions. Temporary junction creation and atomic rename avoid leaving an empty directory at the expected data path after interruption. Existing junctions must resolve to the exact derived target and match the recorded directory identity; arbitrary links cannot be adopted. Preflight skips user-tree recursion in migration mode and retains conservative space allowance for a full application copy fallback.

| Durable state / observed directory state | Recovery |
|---|---|
| Receipt recorded, source only | Verify source ID, resume same-volume move |
| Target only, source link absent | Verify target ID, restore junction |
| Both real source and target exist | Refuse overwrite; preserve both |
| Missing/wrong identity or changed junction | Refuse adoption; preserve evidence and data |
| Original program renamed, target not activated | Restore program directory and data access |
| Target active but health fails | Restore old program; retain edits in shared data |
| Committed | Keep target active; never replay old profile restoration |

Profile configuration still uses its existing bounded snapshot/restore protocol. User workspaces and local skills are independently persistent; program rollback does not rewind their bytes. Candidate/backup cleanup unlinks junctions and never owns the external data directories. External directory moves fail safely when Windows refuses them; there is no copy/delete workaround or blanket process kill.

The application folder is no longer a self-contained copy of user data after migration. Backups must include the sibling data root and receipt. Relocating only the application folder or manually retargeting junctions is not supported by this migration protocol; it intentionally refuses to guess which external data to adopt.

## Validation boundaries

- `verify-portable-zero-copy.ps1`: real Windows process termination at nine migration/activation/commit points; directory identity, data edits, junction cleanup, ambiguous paths, restrictive handles, changed identities, missing receipts, hardlink overwrite rejection and cross-volume fallback.
- `verify-portable-patch-apply.ps1`: reconstruction with literal bracket paths, changed payload preserving old bytes, and existing legacy data-copy regression.
- `verify-portable-update-lifecycle.ps1`: production supervisor and IO-worker processes, real native fixture executable, health success and startup failure rollback. Only the noninteractive CI monitor is substituted. This does not claim Electron business/UI acceptance or bypass the separate signature-admission tests.
- `measure-portable-zero-copy.ps1`: 100,000 unchanged package files, one changed file, 1 GiB user payload; previous copy/verify plus data-copy/five-fingerprint strategy compared to current production reconstruction/migration/switch/recovery. Counters observe handle-helper calls. Fixture generation and cleanup are reported separately. Runs use the same runner/cache state sequentially, not a cold-disk randomized benchmark.

## Native acceptance — 2026-11-17

[CI 43927014750](https://github.com/CyberShp/pangea-desktop/actions/runs/43927014750) passed all five jobs at Desktop `62325d7` (full SHA and updater SHA-256 in [ci-summary.json](backend-updater-zero-copy-20261117/ci-summary.json)). Subsequent documentation commits do not change the tested code. Agent `96f572106c685ce6b3070b7c97128a35f10988fb` is committed, pushed and exactly pinned in the Desktop candidate. Both repositories remain on independently authorized branches; neither is merged or released.

The native Windows PowerShell 5.1 / NTFS fixture contains 100,000 unchanged package files and a 1 GiB user payload. The comparison uses the production patch function with copy-only control, then the production hardlink path on the same runner. It is not a reproduction of the original user's 20-minute installation or a cold-cache randomized benchmark.

| Measured operation | Time |
|---|---:|
| Copy reconstruction | 87.200 s |
| Legacy data copy plus five fingerprints | 6.372 s |
| Copy comparison subtotal | 93.572 s |
| Verified hardlink reconstruction | 41.951 s |
| Persistent data migration | 0.133 s |
| Directory switch | 0.305 s |
| Hardlink/migration/switch subtotal | 42.389 s |
| Recovery rollback (data edits preserved) | 0.225 s |
| **Complete production supervisor, including preflight/workers/health/cleanup** | **79.195 s** |

The component subtotal improved 54.7%. **The complete supervisor has not met the under-60-second target.** Its separate fixture has 100,000 extra package files (100,003 total) and 1 GiB data, real native app/worker processes, and only the CI progress monitor substituted. Logs show preflight around 7 s, patch worker around 47 s, then profile/data/launch/health, and about 21 s for old-version cleanup. Health is confirmed before cleanup. Cleanup is still included in the reported total; moving it outside the timer would not prove an end-to-end speedup. No claim is made that this fixture measures Electron UI startup or the user's Defender/storage workload.

Both reconstruction counters match their mode: copy control 100,000 copied; candidate 100,000 linked, zero copied; one changed payload each. The no-lock benchmark records zero handle scans and zero handle-worker starts. This is not a contention benchmark. Resident helper reuse and live holder safety are covered by separate native tests and the earlier resident acceptance.

Native crash tests passed at nine durable migration/activation states, including a write by the attempted version before rollback. Restrictive/live-writer handles preserve data and resume after release; wrong junctions, replaced identities, missing receipts and conflicting real directories fail closed. Corrupt baseline bytes and attempts to overwrite shared links are rejected. A real cross-volume link attempt falls back to a verified independent copy. Production supervisor healthy and failed-start cases both pass. Reports are in [the evidence directory](backend-updater-zero-copy-20261117).

Windows updater regressions include 44 Vitest checks plus native process identity, rollback, path, IO, health and data tests. Windows component assembly passed typecheck, 218 Vitest checks and Electron build. Linux tooling suites passed 74 + 14 + 37 checks, including signature/trust admission. These counts overlap in scope and are not presented as a total of unique tests.

### Long paths and prepared Windows instance

Source and freshly assembled `win-unpacked` both pass with isolated Git defaults `core.longpaths=false` and `true`. The disabled-default negative control fails as expected, while both wrappers clone/checkout the 489-character absolute path and complete HTTP import/configure/generate/failure/recovery. Source HEAD, snapshots, remote branches and Git configuration remain unchanged. The packaged and source code hashes agree. These are deterministic model fixtures, not live-model quality tests.

[Download the unsigned Windows test instance](https://github.com/CyberShp/pangea-desktop/actions/runs/43927014750/artifacts/14256873686) (GitHub artifact, seven-day retention; 327,684,698-byte archive). SHA-256: `6cb0168a2dbfedf7d963d57db2f27c6a890f0147402d86c7249cbcdd1c6e3c90`. Extract to a separate test directory; the executable is `PANGEA Desktop.exe` at the artifact root. It is an assembled test instance, not a signed release or production update package. A local delivery bundle additionally contains `Start-Isolated-Test.cmd`, setting the application-owned `PANGEA_USER_DATA_DIR` to its own `test-profile` and local skills to the extracted test directory. The Chromium `--user-data-dir` switch alone is insufficient because application identity configuration sets userData explicitly. Use the supplied launcher in the separate test bundle. Windows UI/manual business acceptance remains pending.

### Agent acceptance and limitations

Windows runs the exact pinned Agent source with the same source/runtime-root layout used by Desktop. All 27 tracked deterministic tests (11 evidence contracts, 6 coverage, 3 flow, 7 retired-review regressions) and report delivery smoke pass. Local acceptance additionally covers diagnostics/store integration. New-scene contracts provide readiness diagnostics, frozen source facts, one bounded High/Critical caller-falsification pass within the existing Analysis worker, and cross-unit interface/error-code reconciliation. They do not restore the retired whole-record reviewer or change existing frozen Runs. Diagnostics remain precise advisories; they do not auto-reclassify semantics or prove a call graph. Live-model adherence and comparative output quality have not been measured; small-fixture static-check timing is not a guarantee that every full Run completes validation below one second.

### Performance implementation details

Unchanged files are handled in bounded 512-file batches with up to four native workers. Validated source/destination ancestor handles remain pinned for the reuse session; destination handles allow creation while preventing directory replacement, and all handles are released before switching or on failure. Path normalization allocates buffers proportional to the actual path and grows them when required, retaining the Windows maximum and all checks. This removes repeated oversized allocations without removing SHA-256 validation, identity checks or path guards.


## Phase B: stable launcher design

Keep a stable launch root with a small launcher, `versions/app-<version>-<manifest-hash>/`, and persistent `data/`. Build and verify inactive versions while the app runs. A versioned activation record contains only validated relative version IDs, manifest identity, previous version, transaction ID and an unpredictable health nonce. No arbitrary executable paths are accepted.

The launcher takes the same installation lock, validates the selected completed version and atomically switches a write-through activation record. It launches the version executable with explicit `PANGEA_WORKSPACE_ROOT`, local-skills and profile locations. Health must match PID/creation time, version and nonce. Failed or interrupted activation selects the previous complete version; it never renames the stable launch root and never deletes data. Cleanup only removes inactive, receipt-owned version directories after health confirmation.

First migration remains a separately journaled operation: old layouts may require a one-time directory move; an occupied data root can block that step without data loss. Historical versions need a compatibility adapter until they accept the stable data location. Shortcut/file-association compatibility, same-user concurrent launcher exclusion, signed launcher replacement, unavailable external data and pointer corruption need native tests before enabling this architecture. This is a design, not an implemented 10–15-second launcher claim.
