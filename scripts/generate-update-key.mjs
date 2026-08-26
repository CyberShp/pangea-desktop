import { generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const output = valueAfter('--output')
if (!output) throw new Error('Usage: node scripts/generate-update-key.mjs --output <private-key.pem>')

const destination = path.resolve(output)
const passphrase = process.env.PANGEA_UPDATE_KEY_PASSPHRASE
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const privatePem = privateKey.export({
  type: 'pkcs8',
  format: 'pem',
  ...(passphrase ? { cipher: 'aes-256-cbc', passphrase } : {})
})
const publicPem = publicKey.export({ type: 'spki', format: 'pem' })

await mkdir(path.dirname(destination), { recursive: true })
await writeFile(destination, privatePem, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
await chmod(destination, 0o600).catch(() => undefined)
await writeFile(`${destination}.public.pem`, publicPem, { encoding: 'utf8', flag: 'wx' })
console.log(`PANGEA update signing key created at ${destination}`)
console.log(`Public key created at ${destination}.public.pem`)

function valueAfter(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
