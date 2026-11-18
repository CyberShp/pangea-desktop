import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '..')
const read = (name: string) => readFile(path.join(root, name), 'utf8')

describe('fault injection delivery acceptance', () => {
  it('fails closed with a machine-readable report when the required platform or package is unavailable', async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'pfi-gate-'))
    try {
      const report = path.join(folder, 'result.json')
      const result = spawnSync(process.execPath, [path.join(root, 'scripts/verify-fault-injection-compat.mjs'),
        '--require-windows', '--companion', path.join(folder, 'missing'), '--report', report], { encoding: 'utf8' })
      expect(result.status).toBe(1)
      const evidence = JSON.parse(await readFile(report, 'utf8'))
      expect(evidence.status).toBe('failed')
      expect(evidence.checks).toEqual([])
      expect(evidence.error).toMatch(process.platform === 'win32' ? /ENOENT/ : /Native Windows is required/)
    } finally { await rm(folder, { recursive: true, force: true }) }
  })

  it('runs native acceptance for component and verifier changes and retains failures without publishing', async () => {
    const workflow = parse(await read('.github/workflows/release-pipeline-tests.yml'))
    for (const event of ['push', 'pull_request']) {
      for (const file of ['pangea.components.json', 'scripts/verify-fault-injection-compat.mjs',
        'scripts/test-packaged-fault-injection.ps1', 'scripts/test-packaged-python-cordis.ps1', 'scripts/build-pangea-desktop.ps1',
        'scripts/verify-pangea-staging.mjs', 'test/semantic-staging.test.ts']) {
        expect(workflow.on[event].paths).toContain(file)
      }
    }
    expect(workflow.permissions.contents).toBe('read')
    const job = workflow.jobs['windows-components']
    expect(job['runs-on']).toBe('windows-2022')
    const verify = job.steps.find((step: { run?: string }) => step.run?.includes('node scripts/verify-fault-injection-compat.mjs'))
    expect(verify.if).toBeUndefined()
    expect(verify['continue-on-error']).toBeUndefined()
    expect(verify.run).toContain('--require-windows')
    expect(verify.run).toContain("if ($LASTEXITCODE -ne 0) { throw")
    const evidence = job.steps.find((step: { with?: { name?: string } }) => step.with?.name === 'windows-fault-injection-compatibility')
    expect(evidence.if).toBe('always()')
    const assembly = job.steps.find((step: { name?: string }) => step.name === 'Assemble unsigned Windows test instance')
    expect(assembly.run).toContain('build-pangea-desktop.ps1 -SkipPackage')
    expect(assembly.run).toContain('npm run package:dir')
    expect(assembly.run).not.toContain('-SkipTests')
    expect(assembly.run).not.toContain('create-signed')
  })

  it('runs Python and Cordis with locked source and bundled runtimes', async () => {
    const workflow = parse(await read('.github/workflows/release-pipeline-tests.yml'))
    const steps = workflow.jobs['windows-components'].steps
    const prepare = steps.find((step: { name?: string }) => step.name === 'Prepare locked Python and Cordis integration environment')
    expect(prepare.run).toContain('$Actual -cne $Component.commit')
    for (const variable of ['PANGEA_PYTHON', 'PANGEA_TEST_PYTHON', 'PANGEA_AGENT_ROOT', 'PANGEA_TEST_APP_ROOT']) {
      expect(prepare.run).toContain(variable + '=')
    }
    const packaged = steps.find((step: { name?: string }) => step.name === 'Verify packaged Python and Cordis integration')
    expect(packaged.if).toBe('inputs.build_unsigned == true')
    expect(packaged['continue-on-error']).toBeUndefined()
    expect(packaged.run).toContain('test-packaged-python-cordis.ps1')
    const helper = await read('scripts/test-packaged-python-cordis.ps1')
    for (const runtime of ['node_modules/node/bin/node.exe', 'resources/pangea-python/python.exe', 'resources/pangea-runtime']) {
      expect(helper).toContain(runtime)
    }
    expect(helper).toContain('& $Node --test')
    expect(helper).toContain('cordis-launch.integration.mjs')
    expect(helper).toContain("if ($LASTEXITCODE -ne 0) { throw")
  })

  it('rejects skipped tests for delivery and validates packaged runtime before signing', async () => {
    const build = await read('scripts/build-pangea-desktop.ps1')
    expect(build).toMatch(/if \(\$SkipTests -and -not \$SkipPackage\)\s*\{\s*throw/)
    const packaging = build.indexOf("Invoke-Checked 'npm' @('run', 'package:dir')")
    const acceptance = build.indexOf("scripts/test-packaged-fault-injection.ps1")
    const signing = build.indexOf("scripts/create-signed-portable-package.mjs")
    expect(acceptance).toBeGreaterThan(packaging)
    expect(signing).toBeGreaterThan(acceptance)
    expect(build.slice(packaging, acceptance)).not.toContain('if (-not $SkipTests)')
    const helper = await read('scripts/test-packaged-fault-injection.ps1')
    expect(helper).toContain('$Manifest.components.dsh_pangea.commit -cne $Components.dshPangea.commit')
    expect(helper).toContain('node_modules/node/bin/node.exe')
    expect(helper).toContain('--require-windows')
    expect(helper).toContain("if ($LASTEXITCODE -ne 0) { throw")
  })
})
