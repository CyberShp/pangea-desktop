# Portable Windows release runbook

## One-time update key

Create the Ed25519 update key outside the repository. Set a passphrase when the key will be stored on a shared build machine.

```powershell
$env:PANGEA_UPDATE_KEY_PASSPHRASE = '<build-secret>'
node .\scripts\generate-update-key.mjs --output D:\pangea-secrets\update-private.pem
```

Keep `update-private.pem` and its passphrase in the build secret store. The build derives and embeds the public key, so no user-side trust setup is required.

## Release build

The `Build Windows package` workflow is started manually with a SemVer package version. It builds the exact approved commits in `pangea.components.json` and records them in the package manifest. Their source branches are:

- `dsh-desktop`: `main`
- `dsh-pangea`: `codetalks-skill`
- `pangea-agent`: `codetalks-skill`

Creating a package does not advance these component commits. Component upgrades are a separate maintenance operation: select the desired source commits, update `pangea.components.json`, run compatibility checks, and merge the selected `dsh-desktop` baseline into the product when that component is upgraded. Every imported package must have a version greater than the currently running application, and every release must use the same package key.

For a local Windows build, set the version in `package.json` and `package-lock.json`, then run:

```powershell
$env:PANGEA_UPDATE_KEY_PASSPHRASE = '<build-secret>'
.\scripts\build-pangea-desktop.ps1 `
  -UpdatePrivateKeyPath 'D:\pangea-secrets\update-private.pem'
```

The release output is:

```text
pangea-desktop-<version>-windows-x64-portable.zip
pangea-desktop-<version>-windows-x64-portable.zip.sha256
```

The ZIP contains the complete application plus its signed file manifest. It is used unchanged for both first installation and in-app upgrades.

## Internal handoff

1. Open the matching GitHub Release and download the versioned ZIP plus `.sha256`. For a short-lived test build, download the workflow artifact from the completed GitHub Actions run.
2. Copy that ZIP to the internal shared location.
3. Internal users download the ZIP to their PC.
4. In PANGEA Desktop, choose **Import update package** beside DSH settings and select the ZIP.
5. After verification, choose **Restart and update**.

Users handle one file only. Keep prior versioned ZIPs in the shared location when rollback or manual reinstallation may be needed.
