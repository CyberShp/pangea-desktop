import { describe, expect, it } from 'vitest'
import { verifyProductComposition } from '../scripts/verify-product-composition.mjs'

const locked = `- insert:
    - id: pangea-workbench
      name: dsh-pangea
`

describe('product composition verification', () => {
  it('accepts product policy rows followed by the exact locked composition', () => {
    const product = `- id: llm-deepseek
  disabled: true

${locked}`

    expect(() => verifyProductComposition(locked, product)).not.toThrow()
  })

  it('rejects a product composition that changes the locked core layer', () => {
    const product = locked.replace('pangea-workbench', 'renamed-workbench')

    expect(() => verifyProductComposition(locked, product)).toThrow(
      'does not contain the exact locked dsh-pangea composition patch as its final layer'
    )
  })
})
