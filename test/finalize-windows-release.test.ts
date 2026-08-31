import { spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ZipArchive } from 'archiver'
import { stagePortablePackage } from '../src/main/update/portable-package-validator'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('signed portable Windows package', () => {
  it('uses one ZIP for extraction and in-app package import', async () => {
    const packageVersion = process.env.RELEASE_VERSION ??
      JSON.parse(await readFile('package.json', 'utf8')).version as string
    const packageChannel = process.env.PANGEA_PACKAGE_CHANNEL ??
      (packageVersion.includes('-test.') ? 'test' : 'stable')
    const currentVersion = packageChannel === 'test'
      ? `${packageVersion.split('-')[0]}-test.0.0000000`
      : '0.0.9'
    const root = await mkdtemp(path.join(tmpdir(), 'pangea-portable-package-'))
    temporaryRoots.push(root)
    const appDirectory = path.join(root, 'win-unpacked')
    const updateDirectory = path.join(appDirectory, 'resources', 'update')
    const privateKeyPath = path.join(root, 'update-private.pem')
    const outputPath = path.join(root, `pangea-desktop-${packageVersion}-windows-x64-portable.zip`)
    await mkdir(updateDirectory, { recursive: true })
    await Promise.all([
      writeFile(path.join(appDirectory, 'PANGEA Desktop.exe'), 'desktop executable'),
      writeFile(path.join(appDirectory, 'resources', 'pangea-manifest.json'), JSON.stringify({
        product: { name: 'PANGEA Desktop', version: packageVersion },
        components: { python: { version: '3.12.10' } }
      })),
      writeFile(path.join(updateDirectory, 'apply-portable-update.ps1'), 'Write-Host update')
    ])

    const generated = spawnSync(process.execPath, [
      path.join(process.cwd(), 'scripts', 'generate-update-key.mjs'),
      '--output', privateKeyPath
    ], { encoding: 'utf8' })
    expect(generated.status, generated.stderr).toBe(0)

    const prepared = spawnSync(process.execPath, [
      path.join(process.cwd(), 'scripts', 'prepare-portable-update.mjs'),
      '--output-dir', updateDirectory,
      '--private-key', privateKeyPath
    ], { encoding: 'utf8' })
    expect(prepared.status, prepared.stderr).toBe(0)

    const packaged = spawnSync(process.execPath, [
      path.join(process.cwd(), 'scripts', 'create-signed-portable-package.mjs'),
      '--app-dir', appDirectory,
      '--private-key', privateKeyPath,
      '--channel', packageChannel,
      '--version', packageVersion,
      '--output', outputPath
    ], { encoding: 'utf8' })
    expect(packaged.status, packaged.stderr).toBe(0)

    let lastProgress = 0
    const staged = await stagePortablePackage({
      sourcePath: outputPath,
      destinationPath: path.join(root, 'import', 'pangea-desktop.zip'),
      publicKeyPem: await readFile(path.join(updateDirectory, 'pangea-update-public-key.pem'), 'utf8'),
      currentVersion,
      onProgress: (percent) => { lastProgress = percent }
    })
    expect(staged.manifest.version).toBe(packageVersion)
    expect(staged.manifest.components?.python).toEqual({ version: '3.12.10' })
    expect(staged.manifest.files.map((file) => file.path)).toContain('PANGEA Desktop.exe')
    expect(staged.manifest.files.some((file) => file.path.includes('update-private'))).toBe(false)
    expect(staged.packageSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(lastProgress).toBe(100)

    await writeFile(path.join(appDirectory, 'PANGEA Desktop.exe'), 'modified executable')
    const modifiedPackage = path.join(root, 'modified.zip')
    await zipDirectory(appDirectory, modifiedPackage)
    await expect(stagePortablePackage({
      sourcePath: modifiedPackage,
      destinationPath: path.join(root, 'modified-import', 'pangea-desktop.zip'),
      publicKeyPem: await readFile(path.join(updateDirectory, 'pangea-update-public-key.pem'), 'utf8'),
      currentVersion
    })).rejects.toThrow(/不匹配|校验失败/)
  })

  it('binds the external helper to the locally verified ZIP', async () => {
    const [manager, helper] = await Promise.all([
      readFile(path.join(process.cwd(), 'src', 'main', 'update', 'update-manager.ts'), 'utf8'),
      readFile(path.join(process.cwd(), 'build', 'apply-portable-update.ps1'), 'utf8')
    ])
    expect(manager).toContain('expected_size: imported.packageSize')
    expect(manager).toContain('expected_sha256: imported.packageSha256')
    expect(manager).toContain('result_path: resultPath')
    expect(helper).toContain('Get-FileHash $PackagePath -Algorithm SHA256')
    expect(helper).toContain('Move-Item $BackupRoot $InstallRoot')
    expect(helper).toContain("Write-UpdateResult 'failed' $FailureMessage")
    expect(helper).toContain('Start-Process -FilePath $InstalledExecutable')
    expect(helper).toContain('New-Object System.Windows.Forms.ProgressBar')
  })
})

async function zipDirectory(source: string, destination: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(destination, { flags: 'wx' })
    const archive = new ZipArchive({ zlib: { level: 9 } })
    output.once('close', resolve)
    output.once('error', reject)
    archive.once('error', reject)
    archive.pipe(output)
    archive.directory(source, false)
    void archive.finalize()
  })
}
