import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const DATA_DIRECTORIES = ['repositories', 'inbox', 'coverage', 'assets', 'runs', '.pangea'] as const
const MEANINGFUL_DATA_DIRECTORIES = ['repositories', 'inbox', 'coverage', 'assets', 'runs', 'methodologies', '.pangea'] as const
export const PANGEA_DESKTOP_MARKER = 'desktop-initialized.json'

export interface PangeaWorkspaceOptions {
  pythonExecutable?: string
  desktopVersion?: string
  runInitData?: (input: {
    pythonExecutable: string
    launchRoot: string
    runtimeRoot: string
  }) => Promise<void>
}

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
  runtimeRoot: string,
  options: PangeaWorkspaceOptions = {}
): Promise<string> {
  const agentsSource = join(runtimeRoot, '.agents')
  const marker = join(agentsSource, 'pangea', 'dsh.md')
  await readFile(marker, 'utf8')
  await cp(agentsSource, join(launchRoot, '.agents'), { recursive: true, force: true })

  const dataRoot = join(launchRoot, 'pangea-data')
  const hadExistingData = await hasMeaningfulPangeaData(dataRoot)
  if (options.pythonExecutable) {
    await (options.runInitData ?? runPackagedInitData)({
      pythonExecutable: options.pythonExecutable,
      launchRoot,
      runtimeRoot
    })
  } else {
    await Promise.all(DATA_DIRECTORIES.map((name) => mkdir(join(dataRoot, name), { recursive: true })))
  }

  await Promise.all(DATA_DIRECTORIES.map((name) => mkdir(join(dataRoot, name), { recursive: true })))
  await adoptOrRefreshInitializedWorkspace(dataRoot, hadExistingData, options.desktopVersion)
  return dataRoot
}

async function runPackagedInitData(input: {
  pythonExecutable: string
  launchRoot: string
  runtimeRoot: string
}): Promise<void> {
  await execFileAsync(
    input.pythonExecutable,
    ['-m', 'pangea_agent.cli.main', 'init-data'],
    {
      cwd: input.launchRoot,
      windowsHide: true,
      env: {
        ...process.env,
        PANGEA_RUNTIME_ROOT: input.runtimeRoot,
        PANGEA_WORKSPACE_ROOT: input.launchRoot,
        PANGEA_DATA_ROOT: join(input.launchRoot, 'pangea-data'),
        PYTHONPATH: [join(input.runtimeRoot, 'src'), process.env.PYTHONPATH]
          .filter(Boolean)
          .join(delimiter)
      }
    }
  )
}

async function directoryHasEntries(path: string): Promise<boolean> {
  try {
    return (await readdir(path)).length > 0
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function hasMeaningfulPangeaData(dataRoot: string): Promise<boolean> {
  for (const name of MEANINGFUL_DATA_DIRECTORIES) {
    if (await directoryHasEntries(join(dataRoot, name))) return true
  }
  return false
}

async function readDesktopMarker(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return undefined
  }
}

async function writeDesktopMarker(
  dataRoot: string,
  value: Record<string, unknown>
): Promise<void> {
  const markerDirectory = join(dataRoot, '.pangea')
  await mkdir(markerDirectory, { recursive: true })
  const markerPath = join(markerDirectory, PANGEA_DESKTOP_MARKER)
  const temporaryPath = join(markerDirectory, `.${PANGEA_DESKTOP_MARKER}.${randomUUID()}.tmp`)
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  try {
    await rename(temporaryPath, markerPath)
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    await rm(markerPath, { force: true })
    await rename(temporaryPath, markerPath)
  }
}

async function adoptOrRefreshInitializedWorkspace(
  dataRoot: string,
  hadExistingData: boolean,
  desktopVersion?: string
): Promise<void> {
  const markerPath = join(dataRoot, '.pangea', PANGEA_DESKTOP_MARKER)
  const current = await readDesktopMarker(markerPath)
  if (!current && !hadExistingData) return

  const now = new Date().toISOString()
  await writeDesktopMarker(dataRoot, {
    schema_version: 1,
    ...current,
    initialized_at: typeof current?.initialized_at === 'string' ? current.initialized_at : now,
    adopted_existing_data: current ? current.adopted_existing_data === true : true,
    desktop_version: desktopVersion ?? current?.desktop_version ?? null,
    last_started_at: now
  })
}

export function pangeaEnvironment(
  paths: PangeaProductPaths,
  launchRoot: string,
  dataRoot: string,
  inherited: NodeJS.ProcessEnv = process.env,
  desktopVersion?: string
): NodeJS.ProcessEnv {
  return {
    PANGEA_RUNTIME_ROOT: paths.runtimeRoot,
    PANGEA_PYTHON: paths.pythonExecutable,
    PANGEA_WORKSPACE_ROOT: launchRoot,
    PANGEA_DATA_ROOT: dataRoot,
    PANGEA_DESKTOP_VERSION: desktopVersion ?? inherited.PANGEA_DESKTOP_VERSION,
    PYTHONPATH: [join(paths.runtimeRoot, 'src'), inherited.PYTHONPATH]
      .filter(Boolean)
      .join(delimiter)
  }
}
