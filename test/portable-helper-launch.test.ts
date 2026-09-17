import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { expect, it } from 'vitest'

it.skipIf(process.platform !== 'win32')('retries real directory locks and preserves the installation on timeout', () => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.resolve('scripts/verify-portable-update-locks.ps1')], {
    encoding: 'utf8', timeout: 45_000,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'))
  })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('PASS: persistent directory lock')
  expect(result.stdout).toContain('PASS: transient directory lock')
  expect(result.stdout).toContain('PASS: rollback rename')
}, 50_000)

it.skipIf(process.platform !== 'win32')('executes the Windows helper after its launching process exits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pangea-helper-'))
  try {
    const script = path.join(root, 'helper.ps1')
    const marker = path.join(root, 'ready.txt')
    await writeFile(script, 'param([string]$PlanPath)\n$ErrorActionPreference = "Stop"\n[System.IO.File]::WriteAllText("$PlanPath.ready", "ready")\nStart-Sleep -Milliseconds 300\nGet-FileHash -LiteralPath $PSCommandPath | Out-Null\n[System.IO.File]::WriteAllText($PlanPath, "executed")\n')
    const launcher = pathToFileURL(path.resolve('src/main/update/launch-portable-helper.ts')).href
    const parent = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { launchPortableHelper } from ${JSON.stringify(launcher)}; await launchPortableHelper(${JSON.stringify(script)}, ${JSON.stringify(marker)});`
    ], { encoding: 'utf8', timeout: 5000 })
    expect(parent.status, parent.stderr).toBe(0)
    let result = ''
    for (let attempt = 0; attempt < 30; attempt++) {
      result = await readFile(marker, 'utf8').catch(() => '')
      if (result) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(result).toBe('executed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(process.platform !== 'win32')('reconstructs bracket-named files and preserves portable user data', () => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.resolve('scripts/verify-portable-patch-apply.ps1')], {
    encoding: 'utf8', timeout: 15_000,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'))
  })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('PASS: bracket paths and patch reconstruction')
  expect(result.stdout).toContain('PASS: user data copied and rollback source retained')
})
