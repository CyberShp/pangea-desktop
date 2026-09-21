# PANGEA bundled Archify

Source: https://github.com/tt-a1i/archify
Commit: 10722002bb8777ecb639d93c49586fae4adf3ae4
Version: 2.17.0-dev.1 (pinned development revision, not a stable release claim)
License: MIT; see LICENSE and THIRD_PARTY_NOTICES.md.
Upstream tests and development lockfile are omitted.
PANGEA patch: workflow schema v2 derives omitted node widths from existing text
measurements before layout; explicit widths, schema v1, and validation remain unchanged.
Regression coverage: test/archify-workflow.test.js in the Desktop repository.
PANGEA runs the packaged Node CLI with ARCHIFY_UPDATE_CHECK_DISABLED=1.
No community DSH plugin or runtime package installation is used.
