# Portable Windows release runbook

## One-time update key

Create the Ed25519 update key outside the repository. Set a passphrase when the key will be stored on a shared build machine.

```powershell
$env:PANGEA_UPDATE_KEY_PASSPHRASE = '<build-secret>'
node .\scripts\generate-update-key.mjs --output D:\pangea-secrets\update-private.pem
```

Keep `update-private.pem` and its passphrase in the build secret store. The workflow uses `PANGEA_UPDATE_PRIVATE_KEY_B64` and `PANGEA_UPDATE_KEY_PASSPHRASE`. The build derives and embeds the public key, so no user-side trust setup is required. Keep the same signing key for compatible upgrades; a different key does not authorize replacing an existing package.

## Choose the workflow mode

Start `Build Windows package` (`release.yml`) on the approved source branch with:

| Input | `build` mode | `backfill` mode |
| --- | --- | --- |
| `mode` | `build` (default) | `backfill` |
| `channel` | `release` for stable, or `test` | Channel of the existing target release |
| `version` | Base SemVer, such as `2.0.1` | Exact existing target version, such as `2.0.1` or `2.0.1-test.42.abcdef0` |

The minimum supported patch baseline is **2.0.0** (including the 2.x test channel). **1.x and older upgrade paths are retired.** They are excluded before asset lookup, download, trust checks, or patch generation. Historical Releases and installers are retained; this policy does not delete them. Direct patch generation and backfill publication also reject retired 1.x sources.

There is no manual `patch_from_version` input. Both modes discover release history automatically and produce a direct patch from each compatible historical base to the target. No intermediate release needs to be installed when a verified patch exists for the user's exact installed version.

### Build a new target

`mode=build, channel=release, version=2.0.1` builds exactly `2.0.1`. A test build with the same input version resolves to `2.0.1-test.<run-number>.<short-sha>`. Push-triggered builds use build mode and the test channel.

Before building, the workflow rejects a target version if either its Git tag or GitHub Release already exists. It checks availability again immediately before publishing. This applies to stable and test releases, including reruns. Existing assets are never overwritten. If a previous build already published the target, use backfill to add historical patches or choose a new target version to change the program.

The workflow builds the target once, validates that full package, then generates and verifies historical patches against that same target. It builds the exact approved commits in `pangea.components.json` and records them in the package manifest. Their source branches are:

- `dsh-desktop`: `main`
- `dsh-pangea`: `langgraph`
- `pangea-agent`: `langgraph`

Creating a package does not advance these component commits. Component upgrades are a separate maintenance operation: select the desired source commits, update `pangea.components.json`, run compatibility checks, and merge the selected `dsh-desktop` baseline into the product when that component is upgraded.

For a local Windows build, set the version in `package.json` and `package-lock.json`, then run:

```powershell
$env:PANGEA_UPDATE_KEY_PASSPHRASE = '<build-secret>'
.\scripts\build-pangea-desktop.ps1 `
  -UpdatePrivateKeyPath 'D:\pangea-secrets\update-private.pem'
```

To generate the historical patch set for that local build, use the release tooling with a token authorized to read the repository:

```powershell
$env:GITHUB_REPOSITORY = 'CyberShp/pangea-desktop'
# Set GH_TOKEN using your normal secret-management mechanism.
node .\scripts\build-historical-patches.mjs `
  --mode build `
  --target-version 2.0.1 `
  --channel stable `
  --private-key 'D:\pangea-secrets\update-private.pem' `
  --output-dir .\dist
```

The historical patch script prepares files and verification evidence; it does not publish them.

### Backfill an already published target

For a published stable `2.0.1`, dispatch `mode=backfill, channel=release, version=2.0.1`. For a test target, supply its full test version and `channel=test`.

Backfill downloads and verifies the target release's existing full portable ZIP. It does not run `npm version`, assemble a new target, or run the new-build target integration steps. Locked dependencies are installed with lifecycle scripts disabled. Each generated patch is still applied and verified against the downloaded target, including the patched-program compatibility checks.

After successful verification, backfill adds only patch ZIPs, their checksums, and content-addressed reports to the existing release:

- An absent asset is added.
- An asset with the same name and identical bytes is left untouched.
- An asset with the same name but different bytes causes an error; nothing is overwritten or deleted.
- The full ZIP, full-ZIP checksum, tag, title, and release notes remain unchanged.

Run retries in a clean output directory (GitHub-hosted jobs provide a fresh workspace). Re-running backfill is safe for already-present identical assets. If an upload fails partway through, previously added verified assets remain; a retry checks their bytes before adding the rest. A conflict must be investigated, not worked around with `--clobber`. Backfill cannot be used to rebuild or replace a target under an existing version. If GitHub itself locks the release against any new asset uploads, publication stops with that API error; the workflow does not unlock or replace it.

## Historical coverage and verification

The release tooling paginates through the entire GitHub Release history and its assets. It considers canonical `v<version>` tags, older target-compatible versions at or above 2.0.0 in the same channel, with the expected Windows x64 portable ZIP and checksum. Bases are processed serially and their temporary directories are cleaned up between versions; there is no arbitrary “last N releases” limit.

Patch generation and offline/manual import remain separate: this workflow does not add automatic client update discovery or selection.

Supported bases need schema-1 signed package manifests, the current trusted Ed25519 signing key, complete valid file hashes, and an embedded updater with `Apply-VerifiedPatch`. Legacy packages without signed metadata or patch support, and trusted manifests with unsupported schemas, are explicitly reported as unsupported and use the full ZIP. Invalid signatures or corrupt files remain failures, never legacy exclusions.

For each eligible base, verification checks package integrity and trust, generates a signed file-level patch, and applies the actual patch to the base. The reconstructed program must match the independently validated target manifest. Verification also preserves a pre-existing source-first Run and local skill, loads the reconstructed companion, renders HTML/SVG with bundled Archify, and starts Harness with a migrated profile.

The fixed candidate checks rendering, packaging, and compatibility, not model reasoning. A real configured model session and the application import/restart UI still require end-to-end acceptance; do not report them as covered by the fixed-candidate test.

Every run of the historical patch script writes a report. The report maps base versions to patch assets and records the result and reason for every considered release:

- `verified`: a generated patch passed verification.
- `unsupported`: excluded, for example a draft, unrecognized version, different channel, non-older version, or incompatible package.
- `missing`: an otherwise eligible historical release lacks a required full package or checksum.
- `failed`: a trust, generation, or application/verification error occurred.
- Unfinished work remains explicitly recorded if processing is interrupted; it is not reported as verified.

The report’s `complete` flag is true only when every same-channel older candidate was verified; missing, failed, or legacy-unsupported candidates make it false. Releases excluded by channel, tag format, draft status, or version ordering are listed separately as ineligible. A failed verification causes a nonzero exit and blocks publication. Read the report's exclusions and coverage result before claiming that every historical version is supported. A missing or unsupported base must use the complete ZIP fallback.

The workflow uploads report artifacts even when the historical patch step fails. Reports are content-addressed so subsequent backfills can add new evidence without replacing earlier reports. The job has a 360-minute resource limit. If the runner is terminated before artifact upload can execute, the run logs and any already-uploaded artifacts are the remaining evidence; do not assume that an interrupted run completed coverage.

## Release outputs and internal handoff

A new release always includes the complete portable ZIP and checksum, plus the verified patch set and report:

```text
pangea-desktop-<version>-windows-x64-portable.zip
pangea-desktop-<version>-windows-x64-portable.zip.sha256
pangea-desktop-<version>-from-<base-version>-windows-x64.patch.zip
pangea-desktop-<version>-from-<base-version>-windows-x64.patch.zip.sha256
pangea-desktop-<version>-patch-report-<content-hash>.json
```

The complete ZIP contains the application and its signed file manifest. Each patch contains only changed files plus the target manifest. Every imported package must have a version greater than the currently running application. Test and stable channels never cross. A patch must match the exact installed base version, but it may advance directly over multiple intermediate versions.

No 1.x or older in-app upgrade path is supported. Users of retired versions must install a current complete package separately; this workflow does not validate migration from their old installation. For supported 2.x versions, the complete ZIP remains the fallback when no verified patch matches the installed version or when reinstalling manually.

1. Find the installed version in the application and open the target GitHub Release's patch report.
2. Download the matching exact-base patch and its `.sha256`. If no verified entry matches, download the complete ZIP and its `.sha256`. For a short-lived test build, use the workflow artifact from the completed GitHub Actions run.
3. Copy the selected package to the internal shared location.
4. Internal users download the package to their PC.
5. In PANGEA Desktop, choose **Import update package** beside DSH settings and select the package.
6. After verification, choose **Restart and update**.

Users import one ZIP only. Keep prior versioned full ZIPs in the shared location when rollback or manual reinstallation may be needed.

## Retired release history

The former 1.x Archify repair/backfill instructions are retired. Do not dispatch new 1.x upgrade paths or advertise old 1.x patch assets as supported. Existing historical release assets remain untouched.
