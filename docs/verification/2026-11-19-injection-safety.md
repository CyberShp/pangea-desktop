# Injection safety candidate — macOS acceptance

This candidate changes PANGEA generation and verification export, not a manually patched ShepardOS deliverable. New tasks require current-input/excluded-input scope, negative coverage, setup, cleanup and independent restoration commands. Export owns EXIT/INT/TERM cleanup; failed or incomplete cleanup cannot be automatically imported as passed. The Desktop view exposes all safety stages. Legacy saved exports retain their existing layout.

## Tested artifact and deployment

- Desktop base: `3fa48523d3a08126628457544c99e33ff9cf87aa`; isolated source build with the candidate plugin. No Desktop installer upgrade or release was performed.
- Plugin base: `55a34e0b63e84946dc78047997c011a248e48880`; candidate commit is pinned in `pangea.components.json`.
- ShepardOS baseline: `71f09401db79b3b70f38db0c393512c32ec3d26f`.
- Fresh Desktop analysis Run: `shepardos-ai-ai_conversa-261119-01`.
- Fresh fourth generation task: `d3fba754-c5da-40fe-a7ac-14d100a4c37d`, real DeepSeek V4 Pro; no reused/reference result.
- Generated source tree: `d26b1b55389623c5b1a44f1ff8adaadeeb4d5380`.
- Generated source commit: `b7ac67b17e7f35874d97290587accdc45ccf3b1b`, pushed only to an isolated local bare repository through Desktop. Its tree equals the deployed archive tree.
- API source package: `shepard-api-attempt-04.tar.gz`.
- Package SHA256: `c532438d783c8c4576eb82ed096c3cae5f45084f9acc99b97a05a24e69926e66`.
- Actual Desktop-downloaded Bash export SHA256: `ff22ddd3e5760a0533e9912e627fa5edd965f3e0fe49322fad92763fb0dffe6d`; byte-identical to the host exporter.

The package contains tracked API source and schema files, not bundled Python dependencies or a Windows installer. It was extracted to an isolated deployment directory, every archived source file was compared to the generated checkout, and the agent-owned single-worker API was restarted from that directory. Existing isolated PostgreSQL 16 and production Next.js frontend were retained. Python 3.12 dependencies were already installed in the isolated runtime. Neither source nor exported commands were hand-edited after generation.

The actual fault target is `/ai/chat` conversation persistence: after SQL execute/fetch and before commit, the generated `DatabaseUnavailable` reaches the existing handler and returns HTTP 200 with `stored=false`. This does not establish queue-resource-allocation behavior.

## Executed matrix

| Check | Observed outcome |
| --- | --- |
| History contains marker, current input does not | Stored normally; zero hits; fresh budget remains available |
| Current input contains marker | One hit, `stored=false`, database rollback |
| Repeat request, same conversation ID and exhausted budget | Stored normally; no second hit |
| Disable control with a fresh positive budget | Browser request stored normally; no new hit |
| Remove control file | Browser request stored normally; no new hit |
| Original control nonempty / zero bytes / absent | Three full exported runs; exact original bytes or absence restored |
| Intentional exception after arming | Original exit 1 retained; cleanup and verification both 0; owned data and active sessions restored |
| Real login then injected `/auth/me` 503 | Nonzero primary exit; owned session cleaned; original active session preserved |
| Missing / invalid-base64 backup after real setup and negative execution | Cleanup and verification both exit 1; current control preserved; other owned conversations and auth sessions still cleaned |
| Browser reload after recovery | Same conversation contains 12 persisted messages |

There were 43 real-model business requests against the final deployment: 7 failed saves correlate with 7 fault-hit records and 7 PostgreSQL rollbacks. Browser baseline/history/failure/retry/disabled/removed stages used the same API PID. In the browser, persisted message counts were 2, 4, 4, 8, 10, 12 and final hit count remained 1.

TC-003 intentionally aborts in its negative stage immediately after arming. It does not execute the later positive DB-fault steps: its hit count is 0. Its manual evidence-backed verification records the expected abnormal exit and exact restoration, not an automatic interpretation of exit 1 as success. The other two cases perform the complete negative/positive/retry/removal sequence.

Regression: plugin 1125 passed, 0 failed, 33 skipped, plus four DOM groups passed; 48 targeted safety/service tests passed; Cordis integration 12 passed; Desktop typecheck and build passed; final API persistence/gateway regression 11 passed; final generated control module checks 10 passed. DOM/model fixtures and isolated module tests are separate from the real-model runtime matrix above.

## Earlier attempts and boundaries

Earlier fresh outputs exposed tuple-row decoding, leaked authentication sessions, truthy control flags, zero-byte backup misclassification, late credential persistence and missing/corrupt backup false success. Those failures were retained; changes were made to PANGEA's generation contract/prompt/export/view, then a fresh task was generated and tested. No prior fault result was reused. One suspected syntax error was a split tool-display excerpt; actual AST parsing passed and no syntax fix is claimed.

The structural generation contract cannot prove arbitrary generated code semantics. Windows execution of these new changes, native Windows GUI, SIGKILL/host crash/power loss, multiple API workers, and a lost login response before credential persistence remain unverified. The generated counter uses a file and a process-local lock; cross-process budget guarantees are not claimed. Earlier Windows evidence is not extended by this macOS run.

Full machine-local evidence root: `/Volumes/Media/pangea-injection-safety-20261119`. Key files: `evidence/final-results.json`, `business/evidence/final-http-ai.jsonl`, `final-fault-hits.jsonl`, `final-postgres-transactions.log`, individual `host-verification.json` files, and `output/playwright/`. The configured model key and admin password were scanned out of deliverable evidence/API source. Private runtime state and raw PostgreSQL logs are not deliverables.

No release or external deployment was performed. Original working directories and their uncommitted changes were preserved.
