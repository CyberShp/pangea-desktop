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
with that package's Node and companion. The optional `build_unsigned` input assembles a fresh unsigned `win-unpacked`
from the component lock, runs both disabled/enabled-default packaged checks, and
retains the test instance for seven days. The workflow never signs or publishes
a release.

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

## Original 2.1.25 native Windows result — historical failure

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

That historical CI run remains failed as intended; tooling and Windows updater jobs passed.
The new gate is on the isolated test branch and is not merged into `langgraph`.
At that point plugin behavior had not been modified. The subsequent test-branch
fix and fresh unsigned package acceptance are recorded below; the existing signed
2.1.25 artifact remains unchanged.

Durable reports:

- [Source / disabled](fault-injection-compatibility-20261116/fault-injection-source.json)
- [Package / disabled](fault-injection-compatibility-20261116/fault-injection-packaged.json)
- [Source / enabled](fault-injection-compatibility-20261116/fault-injection-source-enabled.json)
- [Package / enabled](fault-injection-compatibility-20261116/fault-injection-packaged-enabled.json)

## Test-branch correction

The companion's new `withGitLongPaths` helper supplies a temporary configuration
through `GIT_CONFIG_GLOBAL` only to each Windows Git child process. It enables
longpaths before reading the original global configuration and again afterward;
the existing command override remains in place for repository-local overrides.
The original files are included read-only, preserving proxy settings, credential
helpers, relative includes, conditional includes and multivalue settings. No user
configuration file or parent environment variable is modified. Each operation
owns its temporary file and removes it on success, failure or cancellation.
Non-Windows calls keep their original configuration behavior.

The new helper regression tests use real Git to verify configuration preservation,
concurrent isolation and cleanup. The source/HTTP verifier also retains the
unmodified `longpaths=false` negative control and compares original config bytes.
Local targeted plugin regressions passed 21 tests.

The first fresh assembly attempt, run
[43887306157](https://github.com/CyberShp/pangea-desktop/actions/runs/43887306157),
passed both native source variants and plugin suites but failed while reading a
PowerShell 5.1 UTF-8-BOM manifest. The staging verifier now accepts that BOM;
regression coverage proves both matching-manifest acceptance and stale-lock
rejection. No manifest validation was removed.

The first fully successful unsigned assembly was
[43889134345](https://github.com/CyberShp/pangea-desktop/actions/runs/43889134345)
at Desktop `1687f8e4ee931d7a11015c6d7b46d899169b0a5f`, companion
`cb6b308049c561dcff838ecf478c0945ae94b0b0`. Both source and packaged false/true
variants passed; all four recorded runtime source hashes matched.

A follow-up gate run
[43890376610](https://github.com/CyberShp/pangea-desktop/actions/runs/43890376610)
passed both compatibility variants and tooling/updater jobs, but exposed a timing
sensitivity in the pre-existing ACP pending-tool test (two result reads instead
of one). Its 20 ms watchdog can race real log/binding I/O. Injecting an 80 ms
dispatch-log delay reproduced premature recovery locally (zero prompts instead
of one); this supports the timing diagnosis but is not the identical CI assertion. The fixture now permits 500 ms for the
intentional pending-turn timeout, retains every prompt/read/settlement/safety
assertion, and keeps that injected latency. All 34 local ACP recovery tests passed.
This changes only test timing; product timeout/recovery policy is unchanged. The
component pin was advanced to include the regression correction, requiring a new
unsigned assembly and acceptance run.

## Final native Windows acceptance — passed

[Run 43891667073](https://github.com/CyberShp/pangea-desktop/actions/runs/43891667073)
completed successfully at Desktop `5ae97ca9935750b8a9cd9e7338c6c56fe7b10171`,
companion `f587ff7d685eb37b8f800c7b5d7f07740a793bba`.
All three jobs (tooling, windows-updater, windows-components) passed.

| Target | Isolated global `core.longpaths` | Result |
| --- | --- | --- |
| Locked source | false | PASS, including unfixed negative control |
| Locked source | true | PASS |
| Fresh unsigned packaged Node + companion | false | PASS, including unfixed negative control |
| Fresh unsigned packaged Node + companion | true | PASS |

Environment: Windows Server 2022, Node 24.9.0, Git 2.56.1.windows.1. Checkout root
length is 174; tracked file path length is 489. All four runtime source hashes
match across all four reports. Original configuration remains false and unchanged
in disabled-default checks. All HTTP, CRLF/content, detached-checkout, failure and
recovery assertions passed.

The Windows plugin suites ran before assembly and again during assembly: dsh-pangea
43 passed; companion 1044 passed / 32 existing skips; asset catalog 119 passed /
1 existing skip; no failures. The pending-tool latency regressions ran. Typecheck,
Electron build, and 215 focused Desktop tests passed, including the BOM/stale-lock
staging check. The existing skips are not counted as passes.

[Unsigned Windows test instance](https://github.com/CyberShp/pangea-desktop/actions/runs/43891667073/artifacts/14238088039)
contains the complete `win-unpacked` directory, retained for seven days. Extract
the artifact to obtain `PANGEA Desktop.exe` and its resources; it is a test instance,
not a published replacement for the existing 2.1.25 package.

Durable final evidence:

- [Source / disabled](fault-injection-compatibility-fixed-20261116/fault-injection-source.json)
- [Source / enabled](fault-injection-compatibility-fixed-20261116/fault-injection-source-enabled.json)
- [Package / disabled](fault-injection-compatibility-fixed-20261116/fault-injection-packaged.json)
- [Package / enabled](fault-injection-compatibility-fixed-20261116/fault-injection-packaged-enabled.json)

Runtime compatibility is verified against real Windows Git/filesystem/HTTP and the
packaged Node/plugin. Model output and analysis projection remain deterministic
fixtures; this is not real-model quality or interactive Electron UI acceptance,
nor an assertion about every Git/Windows version. Both repositories remain on
independent `codex/` test branches. No merge or publication was performed.
