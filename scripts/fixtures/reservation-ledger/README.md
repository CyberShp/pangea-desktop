# Reservation ledger regression fixture

This multi-file C fixture exercises Planning, Analysis, Review and targeted closure across CLI routing, input parsing, business state transitions and persistence. It replaces the stateless `quota.c` fixture only when explicitly selected.

With the existing isolated OpenCode environment configured, run `scripts/verify-opencode-context-matrix.mjs` with:

- `PANGEA_TEST_FIXTURE_ROOT` set to this directory's absolute path.
- `PANGEA_TEST_TARGET_STAGE=unit_planning` to save real Planning records, pause before acceptance, compact the original session and resume it. The default remains `unit_analysis`.
- `PANGEA_TEST_SCENARIO=gate` for a pre-send headroom rejection, or `tool-exhaustion` for actual same-turn provider exhaustion.
- `PANGEA_TEST_ACP_CWD` set to a new, nonexistent isolated directory for each run.

`fixture.json` supplies the user target and frozen source scope. The model chooses the plan and authors all semantic records through the real CLI. Planning results must retain their record IDs and bindings; Graph's derived `source-first-plan.json` is expected to change from an empty placeholder after Planning acceptance. The probe checks the saved unit identities and intent instead of incorrectly requiring that placeholder to stay unchanged.

The sample deliberately remains unfixed for analysis acceptance: the accepted request ID `-` collides with the persisted empty-ID sentinel. Two identical `reserve - 2` commands against a fresh capacity-10 store commit twice instead of deduplicating. Verify this through the real CLI and fresh processes. This oracle lives outside `source/` and is not copied into the model's isolated workspace.

Semantic acceptance must also distinguish unsupported concurrent writers from a supported-use defect. A completed run/report does not establish semantic PASS, and targeted correction is not independent re-review. Keep actual findings, unresolved items and evidence; do not modify the frozen sample or completion states to make a run pass.

If a later action genuinely reaches the provider context limit, preserve the original probe failure and use `scripts/verify-opencode-context-recovery.mjs` against the existing isolated `PANGEA_TEST_ACP_CWD`, with the same runtime, Python, Companion, model and provider environment. It performs real manual compaction, resumes the original action and verifies saved records, session identities, prompt counts and the final report. `PANGEA_TEST_RECOVERY_TAG` must be unique for a new recovery invocation; existing logs are never overwritten. This helper currently exercises speed mode. Its empty `pending` result-shell exception only permits the Graph's first binding to the already assigned task; it does not permit replacing an established identity.

For the separate post-delivery boundary, `PANGEA_TEST_SCENARIO=post-delivery-exhaustion` makes the real model complete and save the selected stage through the CLI, then consume opaque pressure files in the same ACP request. The probe requires a real provider context error, owned process-tree confirmation, ordinary Graph validation, zero pause/continuation for that delivered action and a final report. Omitting `PANGEA_TEST_FIXTURE_ROOT` uses the small quota fixture for this focused boundary; do not present that case as the complex fixture regression. A previously paused action with a valid saved completion is reconciled without another model prompt; the recovery probe records `savedComplete` separately from manual-compaction targets.
