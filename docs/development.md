# PANGEA Desktop development

The supported packaging target is a Windows x64 portable ZIP. macOS can run TypeScript checks, unit tests, the Electron build, exact component tests and a direct Harness composition canary; Windows remains the release gate for ZIP assembly and replacement/rollback behavior.

## Local checks

```bash
npm ci --legacy-peer-deps
npm run typecheck
npm test
npm run build
```

## Windows assembly

Use the single entrypoint:

```powershell
.\scripts\build-pangea-desktop.ps1 `
  -UpdatePrivateKeyPath D:\pangea-secrets\update-private.pem
```

The script:

1. checks out the locked component commits without working-tree changes;
2. verifies the product composition against the locked dsh-pangea bundle;
3. builds and tests all three PANGEA plugin packages;
4. downloads hash-pinned Python and pip artifacts;
5. installs pinned Python dependencies and runs the PANGEA JSON API canary;
6. embeds the package-verification public key;
7. runs Desktop type checks and focused runtime/Profile tests;
8. creates a signed file manifest inside the application directory;
9. builds the single portable/update ZIP plus SHA-256.

Direct `package:win` calls fail when product staging is incomplete.

## Package import implementation

`create-signed-portable-package.mjs` hashes every file in `win-unpacked`, signs that manifest with Ed25519, places the manifest and signature under `resources\update`, then creates one ZIP. The ZIP can be extracted for a first installation or selected from the DSH settings area for an upgrade.

On import, the current application copies the chosen ZIP into `%APPDATA%`, verifies the embedded signature and every signed file hash, and rejects incomplete or older packages. `apply-portable-update.ps1` then runs outside the program directory, rechecks the accepted ZIP, expands entries with path traversal checks, swaps the program directory and starts the new version with a one-time health marker. Harness Ready writes that marker. Timeout or early exit restores the previous directory.
