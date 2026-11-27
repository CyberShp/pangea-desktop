import { describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ensurePangeaWebProfile } from '../src/main/state/pangea-profile'
import { parseCapturedShellOutput } from '../src/main/runtime/harness-runtime'
// @ts-expect-error untyped JS workspace module
import { UpdateAdmission } from '../packages/dsh-pangea-product/update-admission.js'

describe('Audit Batch 4 regressions (#42, #43, #45)', () => {
  it('#42 preserves malformed cordis.patch.yml and avoids rewriting read-only unchanged profile files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pangea-audit42-'))
    try {
      const profileDir = path.join(root, 'profiles', 'web')
      await mkdir(profileDir, { recursive: true })
      const malformedYaml = '- id: dsh-pangea\n- id: custom-plugin\n  config: [unclosed\n'
      const patchPath = path.join(profileDir, 'cordis.patch.yml')
      await writeFile(patchPath, malformedYaml, 'utf8')

      await ensurePangeaWebProfile(root)
      expect(await readFile(patchPath, 'utf8')).toBe(malformedYaml)

      // Clean profile should not rewrite read-only files when no migration is needed
      const cleanRoot = await mkdtemp(path.join(os.tmpdir(), 'pangea-audit42-ro-'))
      try {
        await ensurePangeaWebProfile(cleanRoot)
        const roPatch = path.join(cleanRoot, 'profiles', 'web', 'cordis.patch.yml')
        const roPkg = path.join(cleanRoot, 'profiles', 'web', 'package.json')
        const beforePatchStat = await stat(roPatch)
        const beforePkgStat = await stat(roPkg)
        await chmod(roPatch, 0o444)
        await chmod(roPkg, 0o444)
        try {
          await ensurePangeaWebProfile(cleanRoot)
          expect((await stat(roPatch)).mtimeMs).toBe(beforePatchStat.mtimeMs)
          expect((await stat(roPkg)).mtimeMs).toBe(beforePkgStat.mtimeMs)
        } finally {
          await chmod(roPatch, 0o644)
          await chmod(roPkg, 0o644)
        }
      } finally {
        await rm(cleanRoot, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('#43 forceStop timeout releases admission lock so new tasks and retries are not blocked indefinitely', async () => {
    const admission = new UpdateAdmission(() => [], ['companion'])
    const gate: { resolve: (() => void) | null } = { resolve: null }
    let stopCalls = 0
    admission.registerParticipant('companion', () => gate.resolve !== null, () => {
      stopCalls += 1
      if (stopCalls === 1) {
        return new Promise<void>(resolve => { gate.resolve = resolve })
      }
      return Promise.resolve()
    })

    await expect(admission.forceStop('audit-token-000001', { timeoutMs: 80 })).rejects.toThrow(/强制停止超时/)
    // After timeout, workbench must not be stuck frozen
    expect(() => admission.assertOpen()).not.toThrow()
    expect(admission.status()).toMatchObject({
      ok: true,
      frozen: false,
      forcing: false,
      pendingStoppers: ['companion'],
    })
    expect(admission.release('audit-token-000001')).toEqual({ ok: true, frozen: false })

    // Once the hung stopper settles, a subsequent forceStop succeeds cleanly
    gate.resolve?.()
    gate.resolve = null
    await new Promise(r => setTimeout(r, 20))
    const ok = await admission.forceStop('audit-token-000002', { timeoutMs: 200 })
    expect(ok).toEqual({ ok: true, frozen: true, token: 'audit-token-000002' })
    expect(admission.release('audit-token-000002')).toEqual({ ok: true, frozen: false })
  })

  it('#45 parseCapturedShellOutput handles both NUL-delimited and newline-fallback env after ENV_START_MARKER', () => {
    const nulOutput = 'Welcome banner\n__PANGEA_ENV_START__\0PATH=/usr/local/bin:/usr/bin\0HOME=/home/tester\0'
    const parsedNul = parseCapturedShellOutput(nulOutput, /\n/)
    expect(parsedNul.PATH).toBe('/usr/local/bin:/usr/bin')
    expect(parsedNul.HOME).toBe('/home/tester')

    const newlineFallback = 'Login banner\n__PANGEA_ENV_START__\0PATH=/opt/bin:/usr/bin\nHOME=/home/tester\nLANG=C.UTF-8\n'
    const parsedFallback = parseCapturedShellOutput(newlineFallback, /\n/)
    expect(parsedFallback.PATH).toBe('/opt/bin:/usr/bin')
    expect(parsedFallback.HOME).toBe('/home/tester')
    expect(parsedFallback.LANG).toBe('C.UTF-8')
  })
})
