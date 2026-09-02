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
pangea-desktop-<version>-from-<base-version>-windows-x64.patch.zip
pangea-desktop-<version>-from-<base-version>-windows-x64.patch.zip.sha256
```

The complete ZIP contains the application plus its signed file manifest. When `patch_from_version` is supplied to the workflow, the build also downloads that exact base release and produces a signed file-level patch. The patch contains only changed files plus the target manifest; CI reconstructs the target directory from the base package and rejects any mismatch.

The first build that introduces patch support must be installed as a complete ZIP. For example, users on `0.1.7-test.43.faea7da` must first install the next complete migration build. Later versions can use the matching `from_version` patch. Test and stable channels never cross, and a patch cannot skip its declared base version.

## Internal handoff

1. Open the matching GitHub Release and download either the exact-base patch plus `.sha256`, or the complete ZIP when installing for the first time or crossing versions. For a short-lived test build, download the workflow artifact from the completed GitHub Actions run.
2. Copy the selected package to the internal shared location.
3. Internal users download the package to their PC.
4. In PANGEA Desktop, choose **Import update package** beside DSH settings and select the package.
5. After verification, choose **Restart and update**.

Users handle one file only. Keep prior versioned ZIPs in the shared location when rollback or manual reinstallation may be needed.
