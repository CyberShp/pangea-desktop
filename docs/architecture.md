# PANGEA Desktop architecture

PANGEA Desktop is a Windows product assembled from three independently maintained repositories:

- `pangea-desktop`: Electron host, portable packaging, product identity and update lifecycle.
- `dsh-pangea`: PANGEA Workbench, Analysis companion, report policy and Assets UI/API.
- `pangea-agent`: deterministic PANGEA data, Run, adapter, report and validation runtime.

[`pangea.components.json`](../pangea.components.json) pins their exact commits. The assembly script checks out those commits into `.pangea-build`; it never reads uncommitted files from developer working copies.

## Process and data boundaries

```text
PANGEA Desktop.exe
  -> bundled Node.js
     -> DSH Harness on random 127.0.0.1 port
        -> dsh-pangea-product core bundle
           -> Workbench + Companion + Assets
              -> embedded python.exe -m pangea_agent.cli.main
```

The renderer remains sandboxed and talks to the loopback Harness. The plugin host invokes only the embedded Python path supplied by Electron. Product runtime files live in the extracted program directory; workspaces, repositories, assets, Runs and reports live under `%APPDATA%\pangea-desktop\launch-root`.

The product bundle is part of both the normal web Profile and Safe Mode. DSH's fallback links the Profile to packaged component directories, so first launch does not install PANGEA from the network.

## Whole-package update boundary

```text
Cloud-built signed Portable ZIP
  -> copied to the internal shared location
     -> user selects the downloaded ZIP in DSH Desktop
        -> embedded signature and every packaged file are verified
           -> stop only when Harness has no running sessions
              -> external PowerShell helper swaps the program directory
                 -> new Harness reaches Ready: keep update
                 -> timeout or early exit: restore previous directory
```

The private package key exists only in release infrastructure; the application contains the public key. The signed manifest binds product, channel, version, component versions and the path, byte length and SHA-256 of every file in the ZIP. The same file is therefore both the first-install archive and the in-app upgrade package.

## Product/runtime contract

Electron sets these variables for Harness:

- `PANGEA_RUNTIME_ROOT`: packaged `pangea-agent` snapshot.
- `PANGEA_PYTHON`: packaged `python.exe`.
- `PANGEA_WORKSPACE_ROOT`: application-owned launch workspace.
- `PANGEA_DATA_ROOT`: writable `pangea-data` directory.
- `PYTHONPATH`: packaged `pangea-agent/src`.

The component manifest shipped beside the Runtime records the Desktop, dsh-pangea, pangea-agent and Python versions used by that portable package.
