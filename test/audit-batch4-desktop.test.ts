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
        const roWs = path.join(cleanRoot, 'profiles', 'web', 'pnpm-workspace.yaml')

        // Compact JSON with identical logical manifest + 0444 must not be rewritten (bytes, inode, mode intact)
        const compactManifest = JSON.stringify(JSON.parse(await readFile(roPkg, 'utf8')))
        await writeFile(roPkg, compactManifest, 'utf8')
        const customWorkspace = 'packages:\n  - custom-workspace\n'
        await writeFile(roWs, customWorkspace, 'utf8')

        const beforePatchStat = await stat(roPatch)
        const beforePkgStat = await stat(roPkg)
        await chmod(roPatch, 0o444)
        await chmod(roPkg, 0o444)
        if (process.platform !== 'win32') await chmod(roWs, 0o200)
        try {
          await ensurePangeaWebProfile(cleanRoot)
          const afterPkgStat = await stat(roPkg)
          expect((await stat(roPatch)).mtimeMs).toBe(beforePatchStat.mtimeMs)
          expect(afterPkgStat.ino).toBe(beforePkgStat.ino)
          expect(await readFile(roPkg, 'utf8')).toBe(compactManifest)
          if (process.platform !== 'win32') {
            expect(afterPkgStat.mode & 0o777).toBe(0o444)
          }
          // Omitting optional empty dependencies field on 0444 package.json must also preserve bytes, inode, and mode
          await chmod(roPkg, 0o644)
          const parsedNoDeps = JSON.parse(compactManifest)
          delete parsedNoDeps.dependencies
          const noDepsManifest = JSON.stringify(parsedNoDeps)
          await writeFile(roPkg, noDepsManifest, 'utf8')
          await chmod(roPkg, 0o444)
          const beforeNoDepsStat = await stat(roPkg)
          await ensurePangeaWebProfile(cleanRoot)
          const afterNoDepsStat = await stat(roPkg)
          expect(afterNoDepsStat.ino).toBe(beforeNoDepsStat.ino)
          expect(await readFile(roPkg, 'utf8')).toBe(noDepsManifest)
          if (process.platform !== 'win32') {
            expect(afterNoDepsStat.mode & 0o777).toBe(0o444)
          }
        } finally {
          await chmod(roPatch, 0o644)
          await chmod(roPkg, 0o644)
          if (process.platform !== 'win32') await chmod(roWs, 0o644)
        }
        expect(await readFile(roWs, 'utf8')).toBe(customWorkspace)
      } finally {
        await rm(cleanRoot, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('#43 forceStop timeout and cleanup failures release admission for normal work while blocking normal freeze until retry succeeds', async () => {
    const admission = new UpdateAdmission(() => [], ['companion'])
    const gate: { resolve: (() => void) | null } = { resolve: null }
    let stopCalls = 0
    // Foreground work is already idle (checkBusy returns false) while async cleanup hangs
    admission.registerParticipant('companion', () => false, () => {
      stopCalls += 1
      if (stopCalls === 1) {
        return new Promise<void>(resolve => { gate.resolve = resolve })
      }
      return Promise.resolve()
    })

    await expect(admission.forceStop('audit-token-000001', { timeoutMs: 80 })).rejects.toThrow(/强制停止超时/)
    // After timeout, workbench must not be stuck frozen (normal work can proceed)
    expect(() => admission.assertOpen()).not.toThrow()
    expect(admission.status()).toMatchObject({
      ok: true,
      frozen: false,
      forcing: false,
      pendingStoppers: ['companion'],
    })
    expect(admission.release('audit-token-000001')).toEqual({ ok: true, frozen: false })

    // While cleanup #1 is STILL unfinished, normal freeze with a new token MUST be rejected as busy
    expect(() => admission.freeze('audit-token-000002')).toThrow(/仍有运行、排队或收尾中的任务/)
    expect(admission.status()).toMatchObject({
      ok: true,
      frozen: false,
      pendingStoppers: ['companion'],
    })

    // Retrying forceStop while cleanup #1 is STILL unfinished MUST NOT bypass or clear pendingStoppers
    await expect(admission.forceStop('audit-token-000003', { timeoutMs: 80 })).rejects.toThrow(/强制停止超时/)
    expect(stopCalls).toBe(1)
    expect(() => admission.assertOpen()).not.toThrow()
    expect(admission.status()).toMatchObject({
      ok: true,
      frozen: false,
      forcing: false,
      pendingStoppers: ['companion'],
    })

    // Once the hung stopper finally settles, pendingStoppers clears and freeze/forceStop succeed cleanly
    gate.resolve?.()
    gate.resolve = null
    await new Promise(r => setTimeout(r, 20))
    expect(admission.status()).toMatchObject({
      ok: true,
      frozen: false,
      pendingStoppers: [],
    })
    const ok = await admission.forceStop('audit-token-000004', { timeoutMs: 200 })
    expect(ok).toEqual({ ok: true, frozen: true, token: 'audit-token-000004' })
    expect(admission.release('audit-token-000004')).toEqual({ ok: true, frozen: false })

    // Direct cleanupProcesses failure (and timeout-then-async-failure) must block freeze until retry succeeds
    let cleanupAttempts = 0
    admission.cleanupProcesses = async () => {
      cleanupAttempts += 1
      if (cleanupAttempts === 1) throw new Error('process tree kill failed')
      if (cleanupAttempts === 2) {
        await new Promise(r => setTimeout(r, 120))
        throw new Error('late async cleanup failure')
      }
    }
    await expect(admission.forceStop('audit-token-000005', { timeoutMs: 200 })).rejects.toThrow(/process tree kill failed/)
    expect(() => admission.assertOpen()).not.toThrow()
    expect(() => admission.freeze('audit-token-000006')).toThrow(/仍有运行、排队或收尾中的任务/)

    await expect(admission.forceStop('audit-token-000007', { timeoutMs: 50 })).rejects.toThrow(/强制停止超时/)
    await new Promise(r => setTimeout(r, 110))
    expect(() => admission.freeze('audit-token-000008')).toThrow(/仍有运行、排队或收尾中的任务/)

    const okAfterRetry = await admission.forceStop('audit-token-000009', { timeoutMs: 200 })
    expect(okAfterRetry).toEqual({ ok: true, frozen: true, token: 'audit-token-000009' })
    expect(admission.release('audit-token-000009')).toEqual({ ok: true, frozen: false })
    expect(admission.freeze('audit-token-000010')).toEqual({ ok: true, frozen: true, token: 'audit-token-000010' })
    expect(admission.release('audit-token-000010')).toEqual({ ok: true, frozen: false })
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
