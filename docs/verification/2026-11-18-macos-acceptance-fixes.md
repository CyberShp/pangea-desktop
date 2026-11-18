# 2026-11-18 macOS acceptance integration

Plugin lock: `55a34e0b63e84946dc78047997c011a248e48880`. Agent lock remains `b8eda305f7adabbaf5d082984422c6c703a5ae10`.

- Added UTF-8 BOM to 16 ASCII-only scripts; script bodies are byte-identical. All 28 top-level build/scripts PowerShell files now satisfy the unconditional BOM release check.
- Online update integration fixtures explicitly simulate x64 and restore the original architecture after each test. Stable and test channels also verify ARM rejection before downloads. Production platform restrictions are unchanged.
- Preserved the local release-view commit ancestry while merging current langgraph. Its source/test changes already match the remote version; the component-lock conflict follows the current Agent lock and the newly tested plugin commit.

macOS arm64 validation used Node 25.9.0, Python 3.12.12 and isolated dependencies/data:

- Updater/platform suites: 87 passed; release tools: 180 passed.
- Companion: 1131 passed, 23 existing skips; mandatory DOM: 4/4 suites passed.
- Catalog: 122 passed; main plugin: 45 passed; Cordis: 12 passed; ACP injection: 6 passed.
- Typecheck and Electron main/preload build passed; Companion client output has no drift.
- Both false/true Git longpaths HTTP compatibility runs passed on macOS, with real Git and C fixtures. Models are fixtures, not live generation quality evidence.

Windows PS 5.1 AST parsing, directory-lock rollback/relaunch, TEMP DLL monitoring, native Windows path semantics and win-unpacked execution remain unverified. Other updater paths still contain Add-Type -TypeDefinition; this run does not establish an end-to-end zero-TEMP-DLL guarantee. No signed package or release was produced.
