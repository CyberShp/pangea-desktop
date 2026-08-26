import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const readmes = [
  'README.md',
  'README.zh.md'
]

const requiredFacts = [
  'PANGEA Desktop',
  'pangea.components.json',
  'build-pangea-desktop.ps1',
  'pangea-desktop-<version>-windows-x64-portable.zip',
  'Ed25519',
  'pangea-python',
  'pangea-runtime',
  'docs/windows-validation.md'
]

describe('localized README parity', () => {
  for (const path of readmes) {
    it(`${path} carries the current product facts`, () => {
      const content = readFileSync(path, 'utf8')

      for (const fact of requiredFacts) expect(content).toContain(fact)
      expect(content).not.toContain('dshdesktop.com')
      expect(content).not.toContain('dataelement/dsh-desktop/releases')
    })
  }

  it('keeps every relative Markdown link resolvable', () => {
    const documents = [
      ...readmes,
      'docs/development.md',
      'docs/architecture.md',
      'docs/release-runbook.md',
      'docs/preset-packages.md'
    ]

    for (const path of documents) {
      const content = readFileSync(path, 'utf8')
      const links = content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)

      for (const match of links) {
        const target = match[1]
        if (!target) continue
        if (/^(?:https?:|mailto:)/.test(target)) continue
        const withoutAnchor = target.split('#', 1)[0]
        if (!withoutAnchor) continue
        expect(
          existsSync(resolve(dirname(path), decodeURIComponent(withoutAnchor))),
          `${path} links to missing ${target}`
        ).toBe(true)
      }
    }
  })

  it('does not publish internal working documents', () => {
    expect(existsSync('docs/preset-square-mvp.md')).toBe(false)
    expect(existsSync('docs/windows-profile-repair.md')).toBe(false)
  })
})
