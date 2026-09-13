# PANGEA Desktop

PANGEA Desktop is a portable Windows distribution of the PANGEA analysis product. One ZIP contains the DSH desktop shell, the PANGEA workbench plugins, a locked `pangea-agent` runtime and embedded Python.

The three implementation repositories remain independent. [`pangea.components.json`](./pangea.components.json) records their source branches, exact approved commits and runtime downloads. A cloud release checks out those pinned commits into a temporary staging directory and records them in the package manifest. Updating a component is a separate reviewed operation from creating a new package version.

The `langgraph` component set uses the Agent's `source-first-v1` workflow. The workbench reads typed records and complete original bodies from each Run, linking risks, cases and source evidence by analysis unit and record ID. The runtime advertises supported analysis settings and asset operations; this set supports module analysis in depth mode, with Coverage material supplied as an analysis asset.

New Runs record component versions and file/rule fingerprints in the frozen task contract. The overview's technical details show this creation-time information; historical Runs with no record display “未记录”. The Desktop provides its loaded application version and entry fingerprint to DSH. Git commits are recorded when an actual checkout is available, while portable installations remain identifiable by version and file hashes.

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

Extract the ZIP into a writable directory and run `PANGEA Desktop.exe`. Settings, sessions and task records remain in `%APPDATA%\pangea-desktop`, so a newly extracted package can still show historical tasks. The packaged workspace lives beside the executable in `launch-root`; preserve that directory when replacing an existing installation. See [`docs/windows-validation.md`](./docs/windows-validation.md) for the first-PC acceptance flow.

## In-app ZIP updates

The complete portable ZIP and an incremental patch ZIP are both accepted by the in-app update flow. Move the cloud-built package to the internal shared location. Users download it, choose **Import update package** beside DSH settings, and restart after verification. PANGEA Desktop detects the package type and validates the embedded Ed25519 signatures and file manifests. A patch is accepted only from its declared base version.

The update helper keeps the previous program directory and restores it unless the new Harness reaches Ready. Settings and session/task records remain in the user-data directory. See [`docs/release-runbook.md`](./docs/release-runbook.md) for release-key and internal handoff instructions.

## Runtime layout

- Product runtime: the extracted `resources\pangea-runtime` and `resources\pangea-python` directories.
- Settings, task records and sessions: `%APPDATA%\pangea-desktop\harness` by default (`PANGEA_USER_DATA_DIR` can override the user-data root).
- Writable packaged workspace: `<package>\launch-root`, beside `PANGEA Desktop.exe`.
- Repositories selected for analysis: `<package>\launch-root\pangea-data\repositories`.
- Runs, assets and reports: `<package>\launch-root\pangea-data`.

There is currently no PANGEA task/Run delete action. To clear historical task listings, stop running tasks and fully exit Desktop, then back up and rename `tasks-v1.json` and `monitor-v1.json` under the Harness `dsh-pangea-companion` directory. To remove a Run's stored files too, back up and move the matching `pangea-data\runs\<run_id>` and `pangea-data\.pangea\skill-runs\<run_id>` directories. Sessions under `harness\sessions` are separate chat history. Keep repositories, assets, methodologies and settings; do not remove the whole Harness directory to clear tasks.
