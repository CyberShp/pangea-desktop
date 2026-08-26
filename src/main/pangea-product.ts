import { cp, mkdir, readFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

export interface PangeaProductPaths {
  runtimeRoot: string
  pythonExecutable: string
  manifestPath: string
}
export function pangeaProductPaths(resourcesPath: string): PangeaProductPaths {
  return {
    runtimeRoot: join(resourcesPath, 'pangea-runtime'),
    pythonExecutable: join(resourcesPath, 'pangea-python', 'python.exe'),
    manifestPath: join(resourcesPath, 'pangea-manifest.json')
  }
}

export async function ensurePangeaWorkspace(
  launchRoot: string,
  runtimeRoot: string
): Promise<string> {
  const agentsSource = join(runtimeRoot, '.agents')
  const marker = join(agentsSource, 'pangea', 'dsh.md')
  await readFile(marker, 'utf8')
  await cp(agentsSource, join(launchRoot, '.agents'), { recursive: true, force: true })

  const dataRoot = join(launchRoot, 'pangea-data')
  await Promise.all(
    ['repositories', 'inbox', 'coverage', 'assets', 'runs', '.pangea'].map((name) =>
      mkdir(join(dataRoot, name), { recursive: true })
    )
  )
  return dataRoot
}

export function pangeaEnvironment(
  paths: PangeaProductPaths,
  launchRoot: string,
  dataRoot: string,
  inherited: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    PANGEA_RUNTIME_ROOT: paths.runtimeRoot,
    PANGEA_PYTHON: paths.pythonExecutable,
    PANGEA_WORKSPACE_ROOT: launchRoot,
    PANGEA_DATA_ROOT: dataRoot,
    PYTHONPATH: [join(paths.runtimeRoot, 'src'), inherited.PYTHONPATH]
      .filter(Boolean)
      .join(delimiter)
  }
}
