import { describe, expect, it } from 'vitest'
import { canImportPortableUpdate } from '../src/main/update/update-capability'

describe('portable update environment', () => {
  it('allows import only in a packaged Windows build', () => {
    expect(canImportPortableUpdate(true, 'win32')).toBe(true)
    expect(canImportPortableUpdate(false, 'win32')).toBe(false)
    expect(canImportPortableUpdate(true, 'linux')).toBe(false)
    expect(canImportPortableUpdate(true, 'darwin')).toBe(false)
  })
})
