import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

function normalizePatch(value) {
  return value.replace(/\r\n/g, '\n').trim()
}

export function verifyProductComposition(lockedPatch, productPatch) {
  const locked = normalizePatch(lockedPatch)
  const product = normalizePatch(productPatch)

  if (product === locked || product.endsWith(`\n\n${locked}`)) return

  throw new Error(
    'The product core bundle does not contain the exact locked dsh-pangea composition patch as its final layer.'
  )
}

async function main() {
  const [lockedPath, productPath] = process.argv.slice(2)
  if (!lockedPath || !productPath) {
    throw new Error('Usage: verify-product-composition.mjs <locked-patch> <product-patch>')
  }

  const [lockedPatch, productPatch] = await Promise.all([
    readFile(lockedPath, 'utf8'),
    readFile(productPath, 'utf8')
  ])
  verifyProductComposition(lockedPatch, productPatch)
  console.log('PANGEA product composition matches the locked dsh-pangea core layer.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
