# PANGEA Desktop development

The supported packaging target is Windows x64. macOS can run TypeScript checks, unit tests, the Electron build, exact component tests and a direct Harness composition canary, but it cannot produce the accepted installer.

## Local checks

```bash
npm ci --legacy-peer-deps
npm run typecheck
npm test
npm run build
```

`dsh-better-sidebar@0.15.2` declares peers against an older DSH prerelease range. The product uses the newer bundled DSH and installs with `--legacy-peer-deps`; actual plugin loading is verified separately.

## Windows assembly

Use the single entrypoint:

```powershell
.\scripts\build-pangea-desktop.ps1 `
  -DshPangeaSource D:\src\dsh-pangea `
  -PangeaAgentSource D:\src\pangea-agent
```

The script performs these product checks before packaging:

1. clone the locked component commits, excluding working-tree changes;
2. verify the product composition matches the locked dsh-pangea bundle;
3. build and test all three dsh-pangea packages;
4. download hash-pinned Python and pip artifacts;
5. install pinned PANGEA Python dependencies and run the JSON API canary;
6. run Desktop type checks and focused runtime/Profile tests;
7. verify staging completeness and build the NSIS installer.

Direct `package:win` calls intentionally fail when staging is incomplete.
