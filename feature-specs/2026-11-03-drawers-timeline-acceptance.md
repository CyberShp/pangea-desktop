# Case evidence and execution timeline acceptance

This isolated development package adds:

- A bottom drawer for planned coverage evidence. Coverage references remain design associations, never proof of execution or measured coverage.
- A right-hand source drawer with every explicit evidence entry, including distinct quotes at the same location. Returning to the basis drawer preserves its scroll position.
- Feasibility drawers with unknown historical values preserved, explicit classification totals and cases requiring execution preparation.
- Equal-width horizontal behavior columns per analysis unit, with authored statuses and case/variant navigation. No dragging or state editing.
- Execution/session lanes from recorded host boundaries. Pauses remain gaps, missing historical boundaries remain unknown, and turn completion never implies process termination. Existing Agent session management remains available.

## Automated checks in this test build

The workflow runs the plugin checks, frozen-source/Python integration, isolated application health smoke, packaged Cordis integration and Electron Chromium fixture UI checks. The latter opens the actual shipped React components against deterministic API fixtures. It verifies drawer navigation, distinct source selection, scroll/focus restoration, unknown versus explicit-zero metrics, equal-width board columns, execution selection and responsive layouts. Screenshots and `verification.json` are included in the build-evidence artifact.

The deterministic UI fixture and bound-worker framework integration do not call a real model provider. They must not be described as a real-provider analysis success. Running an actual new analysis still requires the user's configured provider, model and source input.

## Package isolation

Use the included `start-uiux-test.cmd` to launch this development application with its own `uiux-test-profile`. Existing production profile data is not copied, modified or cleared. This is an unsigned development artifact unless the build separately establishes signing; it is not a stable release or an in-place update package.

## Remaining manual acceptance

Once the package is running with an authorized provider, a small source task such as a single `tls_connect` or bounds-check function is suitable for final product acceptance. Check that the task's new recorded execution windows appear, the original session opens from each segment, stop confirmation remains distinct from a returned turn, and case-source evidence refers to the frozen input. Do not infer measured code coverage from the planned-reference drawer.
