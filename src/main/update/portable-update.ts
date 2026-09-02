import { createPublicKey, verify } from 'node:crypto'

export const PORTABLE_UPDATE_SCHEMA_VERSION = 1
export const PORTABLE_UPDATE_PRODUCT = 'PANGEA Desktop'
export const PORTABLE_UPDATE_CHANNEL = 'stable'
export const PORTABLE_UPDATE_TEST_CHANNEL = 'test'
export const PORTABLE_UPDATE_MANIFEST_PATH = 'resources/update/pangea-package-manifest.json'
export const PORTABLE_UPDATE_SIGNATURE_PATH = `${PORTABLE_UPDATE_MANIFEST_PATH}.sig`
export const PORTABLE_PATCH_MANIFEST_PATH = 'pangea-patch-manifest.json'
export const PORTABLE_PATCH_SIGNATURE_PATH = `${PORTABLE_PATCH_MANIFEST_PATH}.sig`
export const PORTABLE_PATCH_TARGET_MANIFEST_PATH = 'target/resources/update/pangea-package-manifest.json'
export const PORTABLE_PATCH_TARGET_SIGNATURE_PATH = `${PORTABLE_PATCH_TARGET_MANIFEST_PATH}.sig`
export const PORTABLE_PATCH_PAYLOAD_PREFIX = 'payload/'

export type PortableUpdateChannel =
  | typeof PORTABLE_UPDATE_CHANNEL
  | typeof PORTABLE_UPDATE_TEST_CHANNEL

export interface PortablePackageFile {
  path: string
  size: number
  sha256: string
}

export interface PortableUpdateManifest {
  schema_version: number
  product: string
  channel: PortableUpdateChannel
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

export type PortablePatchOperation = 'add' | 'replace'

export interface PortablePatchFile {
  path: string
  operation: PortablePatchOperation
  size: number
  sha256: string
}

export interface PortablePatchManifest {
  schema_version: number
  product: string
  channel: PortableUpdateChannel
  from_version: string
  to_version: string
  published_at: string
  target_manifest_sha256: string
  files: PortablePatchFile[]
  deletes: string[]
}

export function parsePortableUpdateManifest(
  input: Buffer | string,
  expectedChannel: PortableUpdateChannel = PORTABLE_UPDATE_CHANNEL
): PortableUpdateManifest {
  const value = JSON.parse(input.toString()) as Partial<PortableUpdateManifest>
  if (value.schema_version !== PORTABLE_UPDATE_SCHEMA_VERSION) {
    throw new Error(`Unsupported PANGEA package schema: ${String(value.schema_version)}`)
  }
  if (value.product !== PORTABLE_UPDATE_PRODUCT) {
    throw new Error(`Unexpected package product: ${String(value.product)}`)
  }
  if (value.channel !== expectedChannel) {
    throw new Error(`Unexpected package channel: ${String(value.channel)}`)
  }
  if (!isVersionForChannel(value.version, expectedChannel)) {
    throw new Error(
      expectedChannel === PORTABLE_UPDATE_CHANNEL
        ? 'Package version must be stable SemVer'
        : 'Test package version must match x.y.z-test.run.sha'
    )
  }
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
  publicKeyPem: string,
  expectedChannel: PortableUpdateChannel = PORTABLE_UPDATE_CHANNEL
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
  return parsePortableUpdateManifest(manifestBytes, expectedChannel)
}

export function parsePortablePatchManifest(
  input: Buffer | string,
  expectedChannel: PortableUpdateChannel = PORTABLE_UPDATE_CHANNEL
): PortablePatchManifest {
  const value = JSON.parse(input.toString()) as Partial<PortablePatchManifest>
  if (value.schema_version !== PORTABLE_UPDATE_SCHEMA_VERSION) {
    throw new Error(`Unsupported PANGEA patch schema: ${String(value.schema_version)}`)
  }
  if (value.product !== PORTABLE_UPDATE_PRODUCT) {
    throw new Error(`Unexpected patch product: ${String(value.product)}`)
  }
  if (value.channel !== expectedChannel) {
    throw new Error(`Unexpected patch channel: ${String(value.channel)}`)
  }
  if (!isVersionForChannel(value.from_version, expectedChannel)) {
    throw new Error('Patch base version is invalid for its channel')
  }
  if (!isVersionForChannel(value.to_version, expectedChannel)) {
    throw new Error('Patch target version is invalid for its channel')
  }
  if (value.from_version === value.to_version || !isNewerPortableVersion(value.to_version, value.from_version, expectedChannel)) {
    throw new Error('Patch target version must be newer than its base version')
  }
  if (!value.published_at || Number.isNaN(Date.parse(value.published_at))) {
    throw new Error('Patch publication time is invalid')
  }
  if (typeof value.target_manifest_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.target_manifest_sha256)) {
    throw new Error('Patch target manifest hash is invalid')
  }
  if (!Array.isArray(value.files) || value.files.length > 200_000 || !Array.isArray(value.deletes) || value.deletes.length > 200_000) {
    throw new Error('Patch file manifest is invalid')
  }
  const files = new Set<string>()
  for (const file of value.files) {
    const normalized = normalizePortableEntryPath(file?.path)
    const identity = normalized.toLowerCase()
    if (files.has(identity)) throw new Error(`Patch contains a duplicate path: ${normalized}`)
    files.add(identity)
    if (file?.operation !== 'add' && file?.operation !== 'replace') {
      throw new Error(`Patch operation is invalid: ${normalized}`)
    }
    if (!Number.isSafeInteger(file?.size) || file.size < 0) {
      throw new Error(`Patch file size is invalid: ${normalized}`)
    }
    if (typeof file?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw new Error(`Patch file hash is invalid: ${normalized}`)
    }
    file.path = normalized
  }
  const deletes = new Set<string>()
  for (const path of value.deletes) {
    const normalized = normalizePortableEntryPath(path)
    const identity = normalized.toLowerCase()
    if (deletes.has(identity)) throw new Error(`Patch contains a duplicate deletion: ${normalized}`)
    if (files.has(identity)) throw new Error(`Patch both changes and deletes: ${normalized}`)
    deletes.add(identity)
  }
  return value as PortablePatchManifest
}

export function verifyPortablePatchManifest(
  manifestBytes: Buffer,
  signatureBase64: string,
  publicKeyPem: string,
  expectedChannel: PortableUpdateChannel = PORTABLE_UPDATE_CHANNEL
): PortablePatchManifest {
  const signature = Buffer.from(signatureBase64.trim(), 'base64')
  if (signature.length !== 64) throw new Error('Patch manifest signature is invalid')
  const publicKey = createPublicKey(publicKeyPem)
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('PANGEA patch public key must use Ed25519')
  }
  if (!verify(null, manifestBytes, publicKey, signature)) {
    throw new Error('Patch manifest signature verification failed')
  }
  return parsePortablePatchManifest(manifestBytes, expectedChannel)
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

export function portableUpdateChannelForVersion(version: string): PortableUpdateChannel {
  if (isStableVersion(version)) return PORTABLE_UPDATE_CHANNEL
  if (isTestVersion(version)) return PORTABLE_UPDATE_TEST_CHANNEL
  throw new Error(`Unsupported PANGEA Desktop version: ${version}`)
}

export function isNewerPortableVersion(
  candidate: string,
  current: string,
  channel: PortableUpdateChannel = PORTABLE_UPDATE_CHANNEL
): boolean {
  const next = comparableVersion(candidate, channel)
  const installed = comparableVersion(current, channel)
  if (!next || !installed) return false
  for (let index = 0; index < next.length; index += 1) {
    const nextPart = next[index]
    const installedPart = installed[index]
    if (nextPart === undefined || installedPart === undefined) return false
    if (nextPart !== installedPart) return nextPart > installedPart
  }
  return false
}

function isStableVersion(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
}

function isTestVersion(value: unknown): value is string {
  return typeof value === 'string' &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-test\.(0|[1-9]\d*)\.[0-9a-f]{7}$/.test(value)
}

function isVersionForChannel(value: unknown, channel: PortableUpdateChannel): value is string {
  return channel === PORTABLE_UPDATE_CHANNEL ? isStableVersion(value) : isTestVersion(value)
}

function comparableVersion(version: string, channel: PortableUpdateChannel): number[] | undefined {
  if (!isVersionForChannel(version, channel)) return undefined
  if (channel === PORTABLE_UPDATE_CHANNEL) return version.split('.').map(Number)
  const match = /^(\d+)\.(\d+)\.(\d+)-test\.(\d+)\.[0-9a-f]{7}$/.exec(version)
  return match?.slice(1, 5).map(Number)
}
