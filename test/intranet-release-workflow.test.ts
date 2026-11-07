import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { expect, it } from 'vitest'

it('generates relative indexes after verified patches and ships both workflow and release assets', () => {
  const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8'))
  const steps = workflow.jobs.build.steps
  const generation = steps.findIndex((step: any) => step.name === 'Generate intranet update index')
  const patches = steps.findIndex((step: any) => step.id === 'historical_patches')
  const artifacts = steps.findIndex((step: any) => step.name === 'Upload workflow artifact')
  const publication = steps.findIndex((step: any) => step.name === 'Publish GitHub release')
  expect(generation).toBeGreaterThan(patches)
  expect(artifacts).toBeGreaterThan(generation)
  expect(publication).toBeGreaterThan(generation)
  expect(steps[generation].if).toBe("steps.release_meta.outputs.mode == 'build'")
  expect(steps[generation].run).toContain('--full-remote-name pangea-desktop.zip')
  expect(steps[generation].run).not.toContain('--download-url')
  expect(steps[generation].run).toContain('--release-notes ./build/release-notes.json')
  expect(steps[generation].run).toContain('if ($LASTEXITCODE -ne 0)')
  for (const file of ['dist/latest.json', 'dist/intranet-upload-list.json']) {
    expect(steps[artifacts].with.path).toContain(file)
    expect(steps[publication].run).toContain(file)
  }
  expect(steps[publication].run).toContain('$OnlineSignature, $IntranetIndex, $IntranetUploadList)')
})
