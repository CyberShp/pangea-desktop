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
    await mkdir(join(runtime, '.agents', 'pangea'), { recursive: true })
    await writeFile(join(runtime, '.agents', 'pangea', 'dsh.md'), 'PANGEA worker contract')

    const dataRoot = await ensurePangeaWorkspace(launch, runtime)
    expect(await readFile(join(launch, '.agents', 'pangea', 'dsh.md'), 'utf8')).toBe(
      'PANGEA worker contract'
    )
    for (const directory of ['repositories', 'inbox', 'coverage', 'assets', 'runs', '.pangea']) {
      expect((await stat(join(dataRoot, directory))).isDirectory()).toBe(true)
    }
  })

  it('pins the embedded interpreter and source tree into the Harness environment', () => {
    const paths = pangeaProductPaths('/resources')
    const environment = pangeaEnvironment(paths, '/workspace', '/workspace/pangea-data', {
      PYTHONPATH: '/existing'
    })
    expect(environment).toMatchObject({
      PANGEA_RUNTIME_ROOT: join('/resources', 'pangea-runtime'),
      PANGEA_PYTHON: join('/resources', 'pangea-python', 'python.exe'),
      PANGEA_WORKSPACE_ROOT: '/workspace',
      PANGEA_DATA_ROOT: '/workspace/pangea-data',
      PYTHONPATH: `${join('/resources', 'pangea-runtime', 'src')}${delimiter}/existing`
    })
  })
})
