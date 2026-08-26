import { createPrivateKey, createPublicKey } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const outputDirectory = required('--output-dir')
const privateKeyPath = valueAfter('--private-key')
const output = path.resolve(outputDirectory)
await mkdir(output, { recursive: true })

if (!privateKeyPath) {
  await writeFile(path.join(output, 'pangea-update.json'), `${JSON.stringify({
    schema_version: 1,
    enabled: false
  }, null, 2)}\n`, 'utf8')
  process.exit(0)
}

const privatePem = await readFile(path.resolve(privateKeyPath), 'utf8')
const privateKey = createPrivateKey({
  key: privatePem,
  format: 'pem',
  passphrase: process.env.PANGEA_UPDATE_KEY_PASSPHRASE
})
if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('The package signing key must use Ed25519')
const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })
await writeFile(path.join(output, 'pangea-update-public-key.pem'), publicPem, 'utf8')
await writeFile(path.join(output, 'pangea-update.json'), `${JSON.stringify({
  schema_version: 1,
  enabled: true,
  public_key_file: 'pangea-update-public-key.pem'
}, null, 2)}\n`, 'utf8')

function valueAfter(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function required(name) {
  const value = valueAfter(name)
  if (!value) throw new Error(`${name} is required`)
  return value
}
