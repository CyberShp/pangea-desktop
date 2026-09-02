# PANGEA Desktop

PANGEA Desktop is a portable Windows distribution of the PANGEA analysis product. One ZIP contains the DSH desktop shell, the PANGEA workbench plugins, a locked `pangea-agent` runtime and embedded Python.

The three implementation repositories remain independent. [`pangea.components.json`](./pangea.components.json) records their source branches, exact approved commits and runtime downloads. A cloud release checks out those pinned commits into a temporary staging directory and records them in the package manifest. Updating a component is a separate reviewed operation from creating a new package version.

This component set runs `codetalks-skill 1.2.0` with PANGEA Asset Management 2.0, derived from `codetalks-fused-v2.4`. Each Run freezes its own Skill copy, selected assets and enabled methodologies; the workbench displays the frozen version and active step IDs from persisted Run state. Lua and openUBMC Lua profiles are selected automatically from the verified source scope.

## Build on Windows x64

Requirements: Git, Node.js, npm, PowerShell 5.1 or newer, and outbound access to the configured source repositories, Python.org and PyPI.

```powershell
git clone ssh://git@ssh.github.com:443/CyberShp/pangea-desktop.git
cd pangea-desktop
node .\scripts\generate-update-key.mjs --output .\.pangea-keys\update-private.pem
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-pangea-desktop.ps1 `
  -UpdatePrivateKeyPath .\.pangea-keys\update-private.pem
```

The portable product is written to:

```text
dist\pangea-desktop-<version>-windows-x64-portable.zip
dist\pangea-desktop-<version>-windows-x64-portable.zip.sha256
dist\pangea-desktop-<version>-from-<base-version>-windows-x64.patch.zip
dist\pangea-desktop-<version>-from-<base-version>-windows-x64.patch.zip.sha256
```

Extract the ZIP into a writable directory and run `PANGEA Desktop.exe`. Application data remains in `%APPDATA%\pangea-desktop`, so replacing the program directory does not remove workspaces or Runs. See [`docs/windows-validation.md`](./docs/windows-validation.md) for the first-PC acceptance flow.

## In-app ZIP updates

The complete portable ZIP and an incremental patch ZIP are both accepted by the in-app update flow. Move the cloud-built package to the internal shared location. Users download it, choose **Import update package** beside DSH settings, and restart after verification. PANGEA Desktop detects the package type and validates the embedded Ed25519 signatures and file manifests. A patch is accepted only from its declared base version.

The update helper keeps the previous program directory and restores it unless the new Harness reaches Ready. Application data remains outside the program directory. See [`docs/release-runbook.md`](./docs/release-runbook.md) for release-key and internal handoff instructions.

## Runtime layout

- Product runtime: the extracted `resources\pangea-runtime` and `resources\pangea-python` directories.
- Writable product workspace: `%APPDATA%\pangea-desktop\launch-root`.
- Repositories selected for analysis: `%APPDATA%\pangea-desktop\launch-root\pangea-data\repositories`.
- Runs, assets and reports: `%APPDATA%\pangea-desktop\launch-root\pangea-data`.
