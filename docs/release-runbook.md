# Portable Windows release runbook

## One-time update key

Create the Ed25519 update key outside the repository. Set a passphrase when the key will be stored on a shared build machine.

```powershell
$env:PANGEA_UPDATE_KEY_PASSPHRASE = '<build-secret>'
node .\scripts\generate-update-key.mjs --output D:\pangea-secrets\update-private.pem
```

Keep `update-private.pem` and its passphrase in the build secret store. The build derives and embeds the public key, so no user-side trust setup is required.

## Release build

The `Build Windows package` workflow is started manually with a SemVer package version. It resolves these configured branches at the start of the run and records their exact commits in the package manifest:

- `dsh-desktop`: `main`
- `dsh-pangea`: `codex/dsh-pangea-workbench`
- `pangea-agent`: `codex/pangea-workflow-rebuild`

The Desktop source must already contain the resolved `dsh-desktop` base commit. The workflow stops instead of attempting an automatic merge when the upstream base has moved. Every imported package must have a version greater than the currently running application, and every release must use the same package key.

For a local Windows build, set the version in `package.json` and `package-lock.json`, then run:

```powershell
$env:PANGEA_UPDATE_KEY_PASSPHRASE = '<build-secret>'
.\scripts\build-pangea-desktop.ps1 `
  -ResolveComponentBranches `
  -UpdatePrivateKeyPath 'D:\pangea-secrets\update-private.pem'
```

The release output is:

```text
pangea-desktop-<version>-windows-x64-portable.zip
pangea-desktop-<version>-windows-x64-portable.zip.sha256
```

The ZIP contains the complete application plus its signed file manifest. It is used unchanged for both first installation and in-app upgrades.

## Internal handoff

1. Download the versioned ZIP and `.sha256` from `/srv/pangea-artifacts/uploads` on the cloud server.
2. Copy that ZIP to the internal shared location.
3. Internal users download the ZIP to their PC.
4. In PANGEA Desktop, choose **Import update package** beside DSH settings and select the ZIP.
5. After verification, choose **Restart and update**.

Users handle one file only. Keep prior versioned ZIPs in the shared location when rollback or manual reinstallation may be needed.
