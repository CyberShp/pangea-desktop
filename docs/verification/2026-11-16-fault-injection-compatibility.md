# Fault injection compatibility delivery gate

## Scope

The same verifier runs against the locked companion source on native Windows and
against the companion plus Node shipped in `win-unpacked` before signing a package.
It creates an isolated temporary data root, a local bare Git remote and an HTTP
server bound to loopback. No user profile, repository, task, remote service or model
credential is used. Only the model result and analysis projection are fixtures;
repository HTTP routes, Git processes, snapshot comparison, task preparation,
diff application, task persistence and recovery use the real product code.

## Required assertions

- Both Git wrappers override `core.longpaths=false` per invocation without modifying
  the local or isolated global configuration. Native Windows also runs an unfixed
  checkout as a negative control and requires it to fail on the same deep file.
- The actual injection checkout root stays below 240 characters and its tracked
  file exceeds 280 characters; the tracked relative path is 314 characters. This tests deep files, not an unsupported overlong
  repository root. Paths contain spaces.
- 212 CRLF-only snapshot files compare as `changed_count=0, eol_only_count=212`.
  One real edit produces `1/211`. BOM removal, binary changes, invalid UTF-8 and a
  snapshot file absent from Git remain visible as content changes.
- HTTP import, repository configuration and defaults lead to an injection task
  reaching `ready` with the expected deep-file diff and a detached checkout.
- A generator failure is observable through HTTP; a subsequent generation succeeds
  in a separate checkout. Snapshots, source HEAD, remote branches and configuration
  remain unchanged. Cleanup failures fail the gate.

## Delivery wiring

`release-pipeline-tests.yml` runs the verifier on Windows whenever the component
lock, verifier, packaged entrypoint or assembly script changes. Failure propagates
to the job; JSON evidence is uploaded even on failure. Its optional
`package_run_id` dispatch input downloads a successful existing build's portable
artifact, checks the ZIP checksum and component pin, then executes the verifier
with that package's Node and companion. This workflow does not build, sign or
publish a release.

`build-pangea-desktop.ps1` runs the source check and the packaged check before
creating the signed ZIP. `SkipTests` is rejected unless `SkipPackage` is also set.
The packaged compatibility check is outside the optional-test block. The release
workflow retains `.pangea-build/verification/` as an artifact. Reports include
platform, Node/Git versions, companion source hashes, measured path lengths and
individual checks; a non-Windows run cannot satisfy `--require-windows`.

## Evidence recorded during implementation

- Existing locked plugin `3dd8250036011f77ea5009274aa5b2674d87f92e`:
  [Windows run 43821958970](https://github.com/CyberShp/pangea-desktop/actions/runs/43821958970),
  job `133148098898`: companion 1041 passed, 0 failed; the CRLF classification and
  long tracked-file regressions both ran and passed. This predates the new HTTP gate.
- Existing package build `43822691783` produced the 2.1.25 portable artifact using
  Desktop `4b7417317a713c25408759b7196c9860348445d7`; it is available for read-only
  package acceptance without another release.
- Local new HTTP gate: macOS, Node 24.9.0 and 25.9.0, Git 2.50.1; passed with checkout root
  length 191 and tracked-file length 506. This is not native Windows acceptance.
- Local repository regression: 8 passed; delivery contracts: 36 passed with an
  isolated canonical temporary directory; TypeScript check passed. Default macOS
  `/var` temporary paths fail the existing portable patch test because the package
  trust check rejects that symlink; the unchanged baseline test fails identically.
  No trust check or assertion was weakened.
- Isolated mutation checks: removing the Git longpaths override or disabling
  CRLF classification each causes the new verifier to exit 1. Original sources
  remain unchanged.

## Native Windows result — delivery blocked

[Final native matrix run 43884768759](https://github.com/CyberShp/pangea-desktop/actions/runs/43884768759)
executed test code `9973909c3922aaff9bdf14e2ef05b6cfe75c4980` against locked plugin
`3dd8250036011f77ea5009274aa5b2674d87f92e` and the unchanged 2.1.25 artifact from
build `43822691783`. No new product build, merge or publication occurred.

Environment: Windows Server 2022, Node 24.9.0 (packaged Node for artifact checks),
Git 2.56.1.windows.1. Source hashes match between the locked checkout and package.

| Target | Isolated global `core.longpaths` | Result |
| --- | --- | --- |
| Locked source | false | FAIL: deep-file checkout reports `Filename too long` |
| Existing 2.1.25 package | false | FAIL: same checkout error |
| Locked source | true | PASS: all HTTP, snapshot, deep-file and recovery assertions |
| Existing 2.1.25 package | true | PASS: same complete assertions with packaged runtime |

Passing tasks had a checkout root of 174 characters and a file path of 489
characters. The disabled-default negative control confirmed that the long tracked
entry exists and fails without support. The fixed wrapper then also failed.
Diagnostic retries using `cwd`, `-C`, environment configuration and repository-local
configuration failed; changing only the disposable global configuration to true
allowed checkout. This establishes configuration-scope sensitivity on this Git
version; the underlying Git initialization/cache mechanism has not been proven.
It does not justify changing a user's global Git configuration.

The first fixture versions exposed a test setup defect: Windows directory discovery
in `git add .` omitted the deep file. The final fixture explicitly seeds the deep
blob/index entry and asserts its presence in the committed tree, following the
[Git for Windows t2031 fixture](https://github.com/git-for-windows/git/blob/v2.56.1.windows.1/t/t2031-checkout-long-paths.sh).
No failed assertion was disabled. The enabled-default scenario runs independently
and cannot erase or bypass the required disabled-default failure.

The CI run remains failed as intended; tooling and Windows updater jobs passed.
The new gate is on the isolated test branch and is not merged into `langgraph`.
Production plugin behavior has not been modified. The remaining defect must be
fixed and the disabled-default source/package checks must pass before delivery.

Durable reports:

- [Source / disabled](fault-injection-compatibility-20261116/fault-injection-source.json)
- [Package / disabled](fault-injection-compatibility-20261116/fault-injection-packaged.json)
- [Source / enabled](fault-injection-compatibility-20261116/fault-injection-source-enabled.json)
- [Package / enabled](fault-injection-compatibility-20261116/fault-injection-packaged-enabled.json)
