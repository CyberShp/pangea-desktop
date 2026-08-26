# PANGEA Desktop architecture

PANGEA Desktop is a Windows product assembled from three independently maintained repositories:

- `pangea-desktop`: Electron host, Windows installer, product identity and component assembly.
- `dsh-pangea`: PANGEA Workbench, Analysis companion, report policy and Assets UI/API.
- `pangea-agent`: deterministic PANGEA data, Run, adapter, report and validation runtime.

[`pangea.components.json`](../pangea.components.json) pins their exact commits. The assembly script checks out those commits into `.pangea-build`; it never reads uncommitted files from the developer's working copies.

## Installed process and data boundaries

```text
PANGEA Desktop.exe
  -> bundled Node.js
     -> DSH Harness on random 127.0.0.1 port
        -> dsh-pangea-product core bundle
           -> Workbench + Companion + Assets
              -> embedded python.exe -m pangea_agent.cli.main
```

The renderer remains sandboxed and talks to the loopback Harness. The plugin host invokes only the embedded Python path supplied by Electron. PANGEA Runtime source and Python packages live in read-only installer resources; workspaces, repositories, assets, Runs and reports live under `%APPDATA%\pangea-desktop\launch-root`.

The product bundle is part of both the normal web Profile and Safe Mode. DSH's installation fallback links the Profile to the packaged component directories, so the first launch does not install PANGEA from the network.

## Product/runtime contract

Electron sets these variables for Harness:

- `PANGEA_RUNTIME_ROOT`: installed `pangea-agent` snapshot.
- `PANGEA_PYTHON`: installed `python.exe`.
- `PANGEA_WORKSPACE_ROOT`: application-owned launch workspace.
- `PANGEA_DATA_ROOT`: writable `pangea-data` directory.
- `PYTHONPATH`: installed `pangea-agent/src`.

The component manifest shipped beside the Runtime records the Desktop, dsh-pangea, pangea-agent and Python versions used by that installer.
