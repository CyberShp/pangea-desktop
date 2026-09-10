import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensurePangeaWorkspace,
  pangeaEnvironment,
  pangeaProductPaths
} from '../src/main/pangea-product'

const temporaryRoots: string[] = []

async function writeRuntimeContracts(runtime: string): Promise<void> {
  await mkdir(join(runtime, '.agents', 'pangea'), { recursive: true })
  await writeFile(join(runtime, '.agents', 'pangea', 'dsh.md'), 'PANGEA worker contract')
  for (const directory of ['agents', 'commands', 'plugins', 'skills']) {
    await mkdir(join(runtime, '.opencode', directory), { recursive: true })
  }
  await writeFile(join(runtime, '.opencode', 'agents', 'pangea-agent.md'), 'PANGEA OpenCode coordinator')
  await writeFile(join(runtime, '.opencode', 'plugins', 'pangea.ts'), 'PANGEA OpenCode tools')
  await writeFile(join(runtime, '.opencode', 'skills', 'SKILL.md'), 'PANGEA test skill')
  await writeFile(join(runtime, '.opencode', 'package.json'), '{"dependencies":{}}\n')
  await writeFile(join(runtime, '.opencode', 'package-lock.json'), '{"lockfileVersion":3}\n')
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })))
})

describe('PANGEA product runtime', () => {
  it('resolves installation-owned runtime resources', () => {
    expect(pangeaProductPaths('C:\\PANGEA\\resources')).toEqual({
      runtimeRoot: join('C:\\PANGEA\\resources', 'pangea-runtime'),
      pythonExecutable: join('C:\\PANGEA\\resources', 'pangea-python', 'python.exe'),
      manifestPath: join('C:\\PANGEA\\resources', 'pangea-manifest.json')
    })
  })

  it('materializes the managed agent rules and writable data layout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pangea-product-'))
    temporaryRoots.push(root)
    const runtime = join(root, 'runtime')
    const launch = join(root, 'launch')
    await writeRuntimeContracts(runtime)

    const dataRoot = await ensurePangeaWorkspace(launch, runtime)
    expect(await readFile(join(launch, '.agents', 'pangea', 'dsh.md'), 'utf8')).toBe(
      'PANGEA worker contract'
    )
    expect(await readFile(join(launch, '.opencode', 'plugins', 'pangea.ts'), 'utf8')).toBe(
      'PANGEA OpenCode tools'
    )
    await expect(stat(join(launch, '.opencode', 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
    for (const directory of ['repositories', 'inbox', 'coverage', 'assets', 'runs', '.pangea']) {
      expect((await stat(join(dataRoot, directory))).isDirectory()).toBe(true)
    }
  })

  it('runs packaged initialization and leaves a fresh workspace ready for onboarding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pangea-product-'))
    temporaryRoots.push(root)
    const runtime = join(root, 'runtime')
    const launch = join(root, 'launch')
    await writeRuntimeContracts(runtime)
    const calls: unknown[] = []

    const dataRoot = await ensurePangeaWorkspace(launch, runtime, {
      pythonExecutable: 'python.exe',
      desktopVersion: '1.2.3',
      runInitData: async (input) => {
        calls.push(input)
        await mkdir(join(launch, 'pangea-data', '.pangea'), { recursive: true })
      }
    })

    expect(calls).toEqual([{ pythonExecutable: 'python.exe', launchRoot: launch, runtimeRoot: runtime }])
    await expect(readFile(join(dataRoot, '.pangea', 'desktop-initialized.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('adopts existing user data without reopening first-use onboarding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pangea-product-'))
    temporaryRoots.push(root)
    const runtime = join(root, 'runtime')
    const launch = join(root, 'launch')
    await writeRuntimeContracts(runtime)
    await mkdir(join(launch, 'pangea-data', 'repositories', 'existing-repo'), { recursive: true })

    const dataRoot = await ensurePangeaWorkspace(launch, runtime, {
      pythonExecutable: 'python.exe',
      desktopVersion: '2.0.0',
      runInitData: async () => undefined
    })
    const marker = JSON.parse(await readFile(join(dataRoot, '.pangea', 'desktop-initialized.json'), 'utf8'))
    expect(marker).toMatchObject({
      schema_version: 1,
      adopted_existing_data: true,
      desktop_version: '2.0.0'
    })
  })

  it('pins the embedded interpreter and source tree into the Harness environment', () => {
    const paths = pangeaProductPaths('/resources')
    const environment = pangeaEnvironment(paths, '/workspace', '/workspace/pangea-data', {
      PYTHONPATH: '/existing'
    }, '1.2.3')
    expect(environment).toMatchObject({
      PANGEA_RUNTIME_ROOT: join('/resources', 'pangea-runtime'),
      PANGEA_PYTHON: join('/resources', 'pangea-python', 'python.exe'),
      PANGEA_WORKSPACE_ROOT: '/workspace',
      PANGEA_DATA_ROOT: '/workspace/pangea-data',
      PANGEA_DESKTOP_VERSION: '1.2.3',
      PYTHONPATH: `${join('/resources', 'pangea-runtime', 'src')}${delimiter}/existing`
    })
  })
})
