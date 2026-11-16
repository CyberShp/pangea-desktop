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

Native result IDs, measurements and unresolved limits are recorded after runs complete; a passing functional test is not a sub-minute performance claim.

## Phase B: stable launcher design

Keep a stable launch root with a small launcher, `versions/app-<version>-<manifest-hash>/`, and persistent `data/`. Build and verify inactive versions while the app runs. A versioned activation record contains only validated relative version IDs, manifest identity, previous version, transaction ID and an unpredictable health nonce. No arbitrary executable paths are accepted.

The launcher takes the same installation lock, validates the selected completed version and atomically switches a write-through activation record. It launches the version executable with explicit `PANGEA_WORKSPACE_ROOT`, local-skills and profile locations. Health must match PID/creation time, version and nonce. Failed or interrupted activation selects the previous complete version; it never renames the stable launch root and never deletes data. Cleanup only removes inactive, receipt-owned version directories after health confirmation.

First migration remains a separately journaled operation: old layouts may require a one-time directory move; an occupied data root can block that step without data loss. Historical versions need a compatibility adapter until they accept the stable data location. Shortcut/file-association compatibility, same-user concurrent launcher exclusion, signed launcher replacement, unavailable external data and pointer corruption need native tests before enabling this architecture. This is a design, not an implemented 10–15-second launcher claim.
