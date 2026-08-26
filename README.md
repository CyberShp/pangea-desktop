# PANGEA Desktop

PANGEA Desktop is the Windows distribution of the PANGEA analysis product. One installer contains the DSH desktop shell, the PANGEA workbench plugins, a locked `pangea-agent` source runtime, and an embedded Python runtime.

The three implementation repositories remain independent. [`pangea.components.json`](./pangea.components.json) records the exact commits and runtime downloads used for an installer. The build clones those commits into a temporary staging directory; source trees are not copied into this repository.

## Build on Windows x64

Requirements: Git, Node.js, npm, PowerShell 5.1 or newer, and outbound access to the configured source repositories, Python.org and PyPI.

```powershell
git clone ssh://git@ssh.github.com:443/CyberShp/pangea-desktop.git
cd pangea-desktop
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-pangea-desktop.ps1
```

When the component repositories are already mirrored locally, pass their paths. The build still checks out the locked commits and excludes local uncommitted changes.

```powershell
.\scripts\build-pangea-desktop.ps1 `
  -DshPangeaSource D:\src\dsh-pangea `
  -PangeaAgentSource D:\src\pangea-agent
```

The NSIS installer is written to `dist\pangea-desktop-windows-x64-setup.exe`. See [`docs/windows-validation.md`](./docs/windows-validation.md) for the first-PC acceptance flow.

## Runtime layout

- Read-only product runtime: the installed `resources\pangea-runtime` and `resources\pangea-python` directories.
- Writable product workspace: `%APPDATA%\pangea-desktop\launch-root`.
- Repositories selected for analysis: `%APPDATA%\pangea-desktop\launch-root\pangea-data\repositories`.
- Runs, assets and reports: `%APPDATA%\pangea-desktop\launch-root\pangea-data`.

The inherited public DSH release workflow is disabled. Internal publishing and update feeds are deliberately not enabled until their destination and signing contract are configured.
