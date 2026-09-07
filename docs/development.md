# PANGEA Desktop development

The supported packaging target is a Windows x64 portable ZIP. macOS can run TypeScript checks, unit tests, the Electron build, exact component tests and a direct Harness composition canary; Windows remains the release gate for ZIP assembly and replacement/rollback behavior.

## Development responsibility

The user supplies commands, confirms actions that require explicit authorization, and performs the final hands-on product acceptance. The Agent owns the routine engineering work: preparing the isolated test project, installing or validating dependencies, running tests and type checks, building plugins and Desktop, synchronizing a local patch into `win-unpacked`, collecting logs/exit codes, and cleaning up test processes it started. The Agent must not hand these routine steps back as a checklist for the user to execute.

Development validation uses the separate `pangea-desktop-analysis-test` project and an uncompressed `win-unpacked` directory. A signed ZIP is a release artifact and must not be edited in place. The Agent may stop only processes it started; existing user Agent/Run/Harness processes, APPDATA/profile data and reports remain untouched unless the user explicitly authorizes otherwise. If physical interaction, credentials or an explicit external authorization is genuinely required, the Agent reports the exact blocker and leaves the user only that final action.

The isolated launcher sets `PANGEA_USER_DATA_DIR` before starting the test executable. Desktop resolves this value to an absolute Electron `userData` path before acquiring the single-instance lock. Validation must confirm that the launched Harness child uses the isolated directory in its `--user-data-dir` argument; changing `APPDATA` or `LOCALAPPDATA` alone is not an isolation mechanism.

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

## Analysis run acceptance

Before a Windows package is handed to product testing, validate the analysis workflow in an isolated profile:

- a real Cordis Context and LocalJobRegistry bind `task/run/attempt/owner/job/startedAt` before the ACP provider starts;
- provider failures remain failures with their diagnostic, while a user-requested cancellation is reported as stopped;
- resume is offered only after the previous execution has a matching, confirmed terminal Job identity;
- malformed and explicitly broken projections remain visible as data warnings and are never marked trusted;
- the right assistant pane shows the selected Run only in its analysis conversation; discussion conversations use native Chat without the full process stream;
- switching tasks, attempts, files and run details preserves the selected task, Run and conversation without showing earlier output;
- at 1920×1080, 1366×768 and 1024×768, including Windows 125% scaling, the assistant remains reachable and does not cover required controls.

The packaged Cordis launch integration runs after `package:dir` and before the signed portable archive is created. Harness readiness and the Cordis launch result are reported separately. Real provider credentials are reserved for the final user-authorized smoke test; routine development uses the controlled fixture.

The Windows ACP release gate uses the packaged Node runtime and the modules under the unpacked application's `node_modules`. It resolves temporary `nga.cmd`, `codeagent.bat`, and `opencode.cmd` entries through the same PowerShell probe used by Desktop, then exercises ACP initialize, session creation, a first prompt, continuation in the same session, and cancellation. It also compares the received argv for empty, spaced, Chinese, metacharacter, and trailing-backslash values. A fixture pass proves the packaged launch shape; NGA, CodeAgent, and OpenCode still require separate real-provider smoke results before compatibility with those particular versions is claimed.

Windows batch commands and arguments reject NUL, CR/LF, double quotes, percent signs, and carets (`^`) before spawning, with the offending argv index in the error. Nested `CALL` can duplicate a quoted caret, so batch mode must not silently pass a changed argument. The packaged gate checks these rejections as well as lossless forwarding of supported arguments through the existing nested `CALL` fixtures. Native executables keep literal caret support; ACP prompt text travels over stdin and is unaffected by this command-line restriction.

The same verification script supports `--native` for cross-platform regression of provider configuration defaults, real ACP prompts, continuation, and cancellation. The focused ACP test runs this path automatically; it is not a substitute for the Windows batch gate. Run presentation consumes the reconciled state endpoint, while Task execution errors remain available in diagnostics; loading another Task must not reuse the previous Task's launch log.

Run status acceptance treats `(data_root, run_id)` as the workflow identity and `task_id + attempt_id + owner_session_id + job_id + startedAt` as execution identity. Browser GET requests may refresh an observed file snapshot but must never create or rewrite ownership. A stale or unreadable state file is shown as stale/unavailable rather than ACK `0/3`; a failed execution can override an older `in_progress` file only when it belongs to the same current attempt. Switching Tasks or Runs must clear the prior snapshot until the exact requested identity is returned.

## Package import implementation

`create-signed-portable-package.mjs` hashes every file in `win-unpacked`, signs that manifest with Ed25519, places the manifest and signature under `resources\update`, then creates one ZIP. The ZIP can be extracted for a first installation or selected from the DSH settings area for an upgrade.

On import, the current application copies the chosen ZIP into `%APPDATA%`, verifies the embedded signature and every signed file hash, and rejects incomplete or older packages. `apply-portable-update.ps1` then runs outside the program directory, rechecks the accepted ZIP, expands entries with path traversal checks, swaps the program directory and starts the new version with a one-time health marker. Harness Ready writes that marker. Timeout or early exit restores the previous directory.
