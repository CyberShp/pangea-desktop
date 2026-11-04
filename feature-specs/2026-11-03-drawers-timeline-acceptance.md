# Workflow UI and record readability acceptance

This development package presents analysis results with a consistent task, case and execution hierarchy:

- Headers, task lists and report entries use a short task name derived from an explicit name or frozen scope and analysis metadata. The complete request remains available in task information.
- Case lists keep names, classification and review controls scannable. Case details retain the full preconditions, steps, expected results, observations and cleanup. Longer analysis notes open in a detail drawer.
- The planned-evidence drawer and nested source drawer retain every explicit evidence entry, including distinct quotes at the same location. Closing a nested drawer restores the parent scroll position and trigger focus; Tab and Escape operate on the topmost dialog.
- Execution/session lanes use recorded host boundaries. Pauses remain gaps, missing historical boundaries remain unknown, and turn completion never implies process termination. Existing Agent session management remains available.
- Structured historical case records with one mismatched closing delimiter can be read through a bounded compatibility rule when the full case structure is unambiguous. The UI displays the parsing diagnosis and original-record entry. Single and batch copies, CSV evidence appendices and XLSX evidence sheets preserve the original body and diagnosis. Truncated, ambiguous or otherwise invalid records remain explicit errors.

## Automated checks

The isolated Windows workflow runs plugin checks, frozen-source/Python integration, application health smoke, packaged Cordis integration and Electron Chromium fixture UI checks. The Chromium checks load the shipped React components against deterministic API fixtures and check case navigation, planned and source evidence, nested drawer scroll/focus, execution selection and responsive layouts. Screenshots and `verification.json` are included in the build-evidence artifact.

Focused tests also cover task-name derivation and complete request preservation, record parsing and refusal boundaries, source references containing nested annotations, and copy/export fidelity. Fixtures do not establish real-provider analysis quality or measured code coverage.

## Existing-result acceptance

Existing NVMe authentication, sessionctl and MQ results were inspected in a local native Electron instance using an isolated copy of the saved task and Run data. The NVMe TC-007 record retains its original malformed body; the reader restores its authored title, two steps, flow association and both source references with a visible parsing explanation. The original records and reports remain unchanged, and the case remains unexecuted.

This acceptance establishes readability and navigation for those saved results. It does not rerun their analysis, change their quality conclusions or validate the business semantics of the authored test steps. Local screenshots and integrity checks are retained separately from the repository.

## Package isolation

Use the included `start-uiux-test.cmd` to launch the Windows development application with its own `uiux-test-profile`. Existing production profile data is not copied, modified or cleared by that launcher. The development artifact is unsigned unless the build separately establishes signing; it is not an in-place update package.

## Manual acceptance

Open an existing task and confirm that its short name remains consistent across the workbench, case list, case detail and execution detail, while task information retains the full request. Open planned evidence, follow a source reference, then close the nested drawer and confirm focus and scroll restoration. Inspect narrow layouts and long case content for unwanted horizontal overflow.

A new analysis requires a configured provider, model and source input. When verifying that path, confirm that recorded execution windows open the original session, stop confirmation remains distinct from a returned turn, and source evidence refers to the frozen input. Planned references are design associations and do not establish measured execution coverage.
