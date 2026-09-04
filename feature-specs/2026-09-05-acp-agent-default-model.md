# ACP Agent-Native Model Selection Implementation Plan

**Feature:** Repository-native enhancement — no Feature ledger exists in this repository
**Goal:** External ACP analyses inherit the Agent's own current session model and reasoning configuration without exposing model selection in PANGEA Desktop.
**Acceptance Criteria:** (1) An external ACP task can be created and started with only a provider ID. (2) PANGEA does not send `model` or `reasoningEffort` to the ACP provider. (3) The new-analysis and Agent Runtime UIs do not ask users to maintain or select external model catalogs. (4) Internal API-backed model selection remains unchanged. (5) Existing stored external tasks remain readable. (6) Component and Desktop regression suites pass.
**Architecture cell:** Existing PANGEA Workbench / DSH ACP provider boundary (repository has no ownership-cell catalog)
**Map delta:** none
**Map delta why:** The change removes duplicated model routing from the existing ACP boundary; it adds no owner, store, router, or extension point.
**Architecture:** `dsh-pangea-companion` will treat the external provider as the complete execution route and omit ACP `agentOptions`. The ACP child therefore keeps the `currentValue` selected by its own `newSession` behavior. PANGEA records provider/job/session state but no longer freezes an external model route.
**Tech Stack:** Node.js ESM, React, DSH subagents/jobs, ACP
**前端验证:** Yes — verify the existing new-analysis and Agent Runtime surfaces no longer expose external model controls.

---

### Task 1: Lock the provider-only task contract

**Files:**
- Modify: `plugins/dsh-pangea-companion/tests/workbench-api.test.mjs`
- Modify: `plugins/dsh-pangea-companion/tests/task-store.test.mjs`
- Modify: `plugins/dsh-pangea-companion/tests/launch-integration.test.mjs`

1. Add a failing test that creates and starts an ACP task with `provider_id` and no `model_route`.
2. Assert the subagent request omits `agentOptions`, while provider/job/session metadata remains authoritative.
3. Add a compatibility fixture proving an older stored external `model_route` still loads without controlling the new launch.
4. Run the focused tests and verify they fail for the current mandatory-model behavior.

### Task 2: Make external execution Agent-native

**Files:**
- Modify: `plugins/dsh-pangea-companion/src/workbench-api.js`
- Modify: `plugins/dsh-pangea-companion/src/index.js`
- Modify: `plugins/dsh-pangea-companion/src/task-store.js`

1. Resolve and validate only the external provider for ACP tasks.
2. Stop requiring or persisting a selected external model route for new tasks.
3. Omit `agentOptions` when starting an ACP subagent so `newSession.configOptions.currentValue` remains authoritative.
4. Keep internal model resolution and selection unchanged.
5. Run the focused tests until green, then run the full companion suite.

### Task 3: Remove external model UX

**Files:**
- Modify: `plugins/dsh-pangea-companion/src/client.js`
- Modify: `plugins/dsh-pangea-companion/src/acp-settings.js`
- Modify: `plugins/dsh-pangea-companion/tests/client.test.mjs`
- Modify: `plugins/dsh-pangea-companion/tests/acp-settings.test.mjs`

1. Add failing UI contract tests proving task readiness depends only on a registered external provider and that external model controls/copy are absent.
2. Remove the external model and Effort controls from new analysis.
3. Remove model-catalog editing from Agent Runtime while tolerating legacy `models` data on read.
4. Render execution identity as the Agent/provider only; do not show “unknown model”.
5. Build the client and run the full companion suite.

### Task 4: Pin the corrected component in Desktop

**Files:**
- Modify: `pangea.components.json`
- Modify: `test/release.test.ts`
- Modify: `test/external-agent-provider-patches.test.ts` only if the optional-options contract needs an explicit guard

1. Commit the component change locally and capture its commit ID.
2. Add or update a Desktop regression assertion for the component pin/ACP-default contract.
3. Update the `dshPangea.commit` lock to the component commit after that commit is available to the build source.
4. Run Desktop focused tests, typecheck, and the full test suite.

### Task 5: Visual and packaged verification

1. Materialize the updated component into an isolated Desktop staging directory.
2. Build without touching the currently running `D:\\fake\\pangea-desktop` instance.
3. Launch the isolated build, create an ACP analysis with no model interaction, and verify the ACP job reaches session creation.
4. Confirm the run uses the Agent's own current model and that no external model picker appears.

### Non-goals

- PANGEA will not inspect or load arbitrary historical Agent sessions.
- PANGEA will not synchronize external Agent model catalogs.
- PANGEA will not override Agent model or reasoning settings.
- Internal DSH/API model selection is unchanged.
