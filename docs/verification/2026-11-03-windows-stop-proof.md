# Windows ACP stop proof repair

Base: `0be4f04888ab66fa06f92370cec48a549666570f`.

## Changes

- Enable launch-time Windows Job containment for `pangea-opencode` as well as `pangea-codeagent` and `pangea-nga`. Discovery-only requests remain excluded.
- Expose startup containment capability and its failure reason in the first ACP diagnostic, without rejecting normal analysis. Native startup failures include root PID, inspected PID, and stage; `OpenProcess` distinguishes Windows errors 87 (process absent) and 5 (access denied).
- After an eligible recovery attempt or explicit stop, missing, negative, or thrown Windows proof still runs the existing owned-child disposal ladder. Root exit does not become whole-tree confirmation. Empty error strings cannot accidentally authorize success.
- Concurrent stop calls share an attempt. Failed proof can be checked again, successful proof is idempotent, and already-completed owned-child disposal is not repeated. A successful retry clears the prior diagnostic failure.

## Verification performed on Linux

Dependencies were copied to this isolated worktree. Shared source checkout and shared dependencies were not edited.

- `vitest run test/acp-stop-proof.test.js test/windows-recovery-fence.test.js test/acp-diagnostics.test.js test/acp-provider-launch.test.js test/acp-worker-lifecycle.test.js`: 95 passed, 1 skipped (native Windows test).
- `npm run typecheck`: passed.
- `npm run build`: passed (Electron main/preload; existing renderer-config warning).
- `npm test`: 758 passed, 15 failed, 8 skipped. All 15 failures reproduced by running the same seven failing suites against unchanged base source in another worktree with the same copied dependencies. Nine LAN tests hit sandbox `uv_interface_addresses` errors; remaining failures are existing branding/model-picker/directory-picker/market-installer/Feishu expectations. This is not an aggregate-green result.
- Regenerated patches checked both against pristine dependency files and in reverse against installed patched files. `git diff --check`: passed.

## Explicit limits and acceptance

Windows native Job behavior and a Windows packaged Desktop were not verified in this Linux environment. The new ACP stop tests use real Linux protocol fixture children and mock the Windows proof boundary during stop; they do not validate Windows system calls.

A process disappearing between snapshot and open remains unconfirmed. Its descendants may already have escaped before containment; retrying later or ignoring the vanished PID would not recover that missing ancestry evidence. Startup proof failure therefore remains unavailable on that run, while exact owned-child cleanup is still attempted. This change introduces no startup rejection, new semantic gate, global process-name termination, push, or release.

Windows acceptance must cover all three providers, a source-first OpenCode run, normal startup with unavailable containment, stop during a pending prompt, failed-proof diagnostics, repeated stop clicks, and child survival after parent exit. Confirm actual descendant termination before accepting a stopped state; unavailable proof must stay visibly unconfirmed.
