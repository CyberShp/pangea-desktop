import { createPublicKey, verify } from 'node:crypto'

export const PORTABLE_UPDATE_SCHEMA_VERSION = 1
export const PORTABLE_UPDATE_PRODUCT = 'PANGEA Desktop'
export const PORTABLE_UPDATE_CHANNEL = 'stable'
export const PORTABLE_UPDATE_MANIFEST_PATH = 'resources/update/pangea-package-manifest.json'
export const PORTABLE_UPDATE_SIGNATURE_PATH = `${PORTABLE_UPDATE_MANIFEST_PATH}.sig`

export interface PortablePackageFile {
  path: string
  size: number
  sha256: string
}

export interface PortableUpdateManifest {
  schema_version: number
  product: string
  channel: string
  version: string
  published_at: string
  files: PortablePackageFile[]
  components?: Record<string, unknown>
}

export interface PortableUpdateConfig {
  schema_version: number
  enabled: boolean
  public_key_file?: string
}

export function parsePortableUpdateManifest(input: Buffer | string): PortableUpdateManifest {
  const value = JSON.parse(input.toString()) as Partial<PortableUpdateManifest>
  if (value.schema_version !== PORTABLE_UPDATE_SCHEMA_VERSION) {
    throw new Error(`Unsupported PANGEA package schema: ${String(value.schema_version)}`)
  }
  if (value.product !== PORTABLE_UPDATE_PRODUCT) {
    throw new Error(`Unexpected package product: ${String(value.product)}`)
  }
  if (value.channel !== PORTABLE_UPDATE_CHANNEL) {
    throw new Error(`Unexpected package channel: ${String(value.channel)}`)
  }
  if (!isStableVersion(value.version)) throw new Error('Package version must be stable SemVer')
  if (!value.published_at || Number.isNaN(Date.parse(value.published_at))) {
    throw new Error('Package publication time is invalid')
  }
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > 200_000) {
    throw new Error('Package file manifest is invalid')
  }

  const paths = new Set<string>()
  for (const file of value.files) {
    const normalized = normalizePortableEntryPath(file?.path)
    const identity = normalized.toLowerCase()
    if (paths.has(identity)) throw new Error(`Package contains a duplicate path: ${normalized}`)
    paths.add(identity)
    if (!Number.isSafeInteger(file?.size) || file.size < 0) {
      throw new Error(`Package file size is invalid: ${normalized}`)
    }
    if (typeof file?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw new Error(`Package file hash is invalid: ${normalized}`)
    }
    file.path = normalized
  }
  for (const required of [
    'PANGEA Desktop.exe',
    'resources/pangea-manifest.json',
    'resources/update/pangea-update.json',
    'resources/update/pangea-update-public-key.pem',
    'resources/update/apply-portable-update.ps1'
  ]) {
    if (!paths.has(required.toLowerCase())) throw new Error(`Package is missing ${required}`)
  }
  return value as PortableUpdateManifest
}

export function verifyPortableUpdateManifest(
  manifestBytes: Buffer,
  signatureBase64: string,
  publicKeyPem: string
): PortableUpdateManifest {
  const signature = Buffer.from(signatureBase64.trim(), 'base64')
  if (signature.length !== 64) throw new Error('Package manifest signature is invalid')
  const publicKey = createPublicKey(publicKeyPem)
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('PANGEA package public key must use Ed25519')
  }
  if (!verify(null, manifestBytes, publicKey, signature)) {
    throw new Error('Package manifest signature verification failed')
  }
  return parsePortableUpdateManifest(manifestBytes)
}

export function normalizePortableEntryPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new Error('Package entry path is invalid')
  }
  const normalized = value.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) {
    throw new Error(`Package entry path is absolute: ${value}`)
  }
  const parts = normalized.split('/').filter((part) => part !== '')
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
    throw new Error(`Package entry path is unsafe: ${value}`)
  }
  return parts.join('/')
}

export function isNewerPortableVersion(candidate: string, current: string): boolean {
  if (!isStableVersion(candidate) || !isStableVersion(current)) return false
  const next = candidate.split('.').map(Number) as [number, number, number]
  const installed = current.split('.').map(Number) as [number, number, number]
  for (const index of [0, 1, 2] as const) {
    if (next[index] !== installed[index]) return next[index] > installed[index]
  }
  return false
}

function isStableVersion(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
}
