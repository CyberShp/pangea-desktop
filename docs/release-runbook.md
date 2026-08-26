# Windows internal release runbook

## Current M0 path

1. Build on a controlled Windows x64 PC with [`build-pangea-desktop.ps1`](../scripts/build-pangea-desktop.ps1).
2. Validate the result with [`windows-validation.md`](./windows-validation.md).
3. Copy the validated installer and `.pangea-build\manifest.json` into the internal artifact store.
4. Record the installer SHA-256 beside the component manifest.

The cloud release workflow is disabled. It must not receive a final installer or internal component source.

## Later internal pipeline

Because the internal network can make outbound connections while the cloud cannot connect inward, the final build belongs on an internal Windows runner. That runner may poll or be dispatched by the cloud control plane, but it must fetch component commits from internal mirrors and publish the installer only to the internal artifact store.

Before enabling that pipeline, decide and configure:

- internal Git URLs or mirror paths for both component repositories;
- code-signing certificate and timestamp policy;
- immutable artifact destination and retention policy;
- update-feed URL reachable by installed PCs;
- promotion rules from validation to release.

Only after those values exist should `build.publish` and the Desktop update manager be enabled.
