# Windows unsigned package and Python/Cordis acceptance

Native Windows Server 2022 acceptance completed on 2026-11-18.
No signing, release creation, or publication was performed.

## Tested revisions and evidence

- Desktop: `488a2828fc561a7d7ecc6aacca1f7e84b34beefc`.
- Plugin: `55a34e0b63e84946dc78047997c011a248e48880`.
- Agent: `b8eda305f7adabbaf5d082984422c6c703a5ae10`.
- [Successful run](https://github.com/CyberShp/pangea-desktop/actions/runs/44314515378): all five jobs passed.
- [Unsigned win-unpacked artifact](https://github.com/CyberShp/pangea-desktop/actions/runs/44314515378/artifacts/14433885361), retention until 2026-11-25.
- Artifact archive SHA-256 reported by GitHub:
  `b29c80e95c59aa433b52a2ce6344800b1c212b28ea8ab085d8a8eb7a611fafc5`.
- Compatibility JSON is retained as `windows-fault-injection-compatibility` in that run.

## Results

| Layer | Actual result |
| --- | --- |
| Locked source HTTP compatibility | Passed with Git core.longpaths false and true |
| Unsigned win-unpacked HTTP compatibility | Passed with Git core.longpaths false and true, using bundled Node and plugin |
| Source main plugin | 45 passed |
| Source Companion | 1132 passed, 22 skipped; includes the real Cordis suite and Python integration |
| Source asset catalog | 122 passed, zero skipped |
| Source ACP adapter delivery | 6 passed |
| Build focused Desktop tests | 218 passed; typecheck and Electron assembly passed |
| Packaged real-Agent selection | 81 passed, 5 explicit legacy skips |
| Packaged Cordis | 12 passed, zero skipped |
| Packaged asset catalog | 122 passed, zero skipped |

The compatibility gate exercised a 314-character tracked relative path and
489-character checkout file path, a failing unfixed negative control, detached
checkout, 212 CRLF-only files, BOM/binary/invalid-UTF-8 changes, HTTP generation
failure and recovery, and unchanged source HEAD/remote branches/Git configuration.

Packaged Python identity was asserted to resolve beneath
`resources/pangea-runtime`. Tests used `resources/pangea-python/python.exe`
and bundled Node, including real Graph depth/speed and 2,000-file scenarios,
both repository-local transports, scope/reference freezing, Chinese asset
titles/errors, independent repeated imports, and persisted malformed-workbook
errors. Cordis tests use real Cordis/Jobs with deterministic provider fixtures;
they do not establish live-model quality.

## Acceptance harness repairs

The source job now installs the locked Agent and supplies the Python and Cordis
environment variables that previously caused environment-dependent skips.
The unsigned artifact explicitly retains hidden runtime directories, including
`.agents` and `.opencode`.

[Earlier run](https://github.com/CyberShp/pangea-desktop/actions/runs/44312336699)
failed one packaged Companion test: the source-only diagnostic test injects a
fake Agent through PYTHONPATH, which isolated embedded Python ignores. The real
CLI correctly rejected a missing contract instead of producing the injected
WinError. The full source suite still covers this test. Packaged acceptance
selects the real-Agent integration suites and separately runs Cordis/catalog;
no product behavior or embedded isolation was weakened to accommodate the fixture.

## Follow-up

The [native observation and benchmark report](2026-11-18-windows-native-observation-benchmark.md)
subsequently covers the complete tracked PS 5.1 scan, scoped launcher DLL observation
and 100k/1 GiB measurements. It retains the unmet full-supervisor timing target
and separates launcher observations from global updater/antivirus claims.

## Unverified at this report’s original checkpoint

- Global zero temporary DLL and antivirus observations.
- Combined real Electron/Windows Terminal directory-lock upgrade and rollback.
- 100,000-file / 1 GiB migration performance benchmarks (disabled for this run).
- Complete PowerShell 5.1 AST sweep beyond the scripts actually executed.
- Explicit retired review/closure tests and legacy verify-cases cancellation
  fixture: source 22 skips remain; packaged selection contains 5 of them.
- Live-model output quality and human GUI acceptance.

Passing these automated gates does not close the remaining acceptance items.
