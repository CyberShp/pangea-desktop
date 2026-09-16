# Windows portable patch acceptance

Validated locally on 2026-09-16 against `langgraph` commit `a81289b` using an isolated installation and profile under `D:/pangea-e2e-targets/langgraph-patch-20260916`.

## Defects reproduced and fixed

- Node's detached Windows PowerShell launch exited without executing the updater. An attached child did not survive its console parent. Launch through PowerShell `Start-Process` with an independent hidden console, sanitize inherited `PSModulePath`, and require a readiness marker before exiting Desktop. Preserve launcher stderr for diagnosis.
- PowerShell wildcard path handling treated `[Content_Types].xml` as missing. Use literal paths when reading, copying, hashing, moving and removing update files.
- Preserve both `local-skills` and `launch-root` in the candidate installation while retaining the originals until the new application reports healthy.
- Index the target manifest once and log stages plus progress every 500 verified files.
- Exclude Python `__pycache__` directories from both the signed manifest and ZIP. Python rewrote 668 signed cache files after startup in the first successful upgrade; unchanged source and executable files retained their hashes. Continue validating every signed file.

## Regression checks

The targeted suite passed 34 tests in 10 files, including real Windows helper lifetime, bracket-named patch reconstruction, portable user-data preservation, signed archive staging, update state, health and release checks. Typecheck and Electron build passed.

```powershell
npx vitest run test/portable-helper-launch.test.ts test/portable-patch.test.ts test/portable-patch-generation.test.ts test/portable-update.test.ts test/portable-update-health.test.ts test/update.test.ts test/update-state.test.ts test/update-ui.test.ts test/finalize-windows-release.test.ts test/release.test.ts --maxWorkers=1 --no-file-parallelism
```

## Real application acceptance and scope

Original official test.95 and test.97 downloads were SHA-256 verified. Independent extracted copies were signed with a dedicated local test key. Because the old updater cannot launch its helper, the test.95 baseline was first bootstrapped with the corrected launcher and helper; this does not demonstrate an unmodified official test.95 installation upgrading itself.

The corrected test.95 desktop imported the generated patch via the native file dialog, verified it, and performed restart/update to local test.98 through the UI. The helper reported success and the new app reported healthy. Four fixture hashes covering private skills, inbox input, run reports and external profile data were preserved. A second UI upgrade from that running test.98 to local test.99 validates continued updating with the cache packaging correction; final results and all evidence are in `D:/pangea-e2e-targets/langgraph-patch-20260916/acceptance-report.md`.

The second upgrade completed successfully at 23:56:57 +08:00. The test.99 app reported healthy, its manifest signature validated, and all 24,539 signed files matched their size and SHA-256 after startup. All four user-data fixtures retained their original hashes. The final full ZIP contained no Python cache entries.

These are local acceptance versions and test signatures, not published releases. The original `D:/pangea-desktop` installation and its user data were not replaced. Existing installations with the broken launcher need a supported full-package/bootstrap migration before relying on this patch path.
