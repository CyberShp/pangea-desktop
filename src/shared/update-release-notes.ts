import type { UpdateReleaseNotes } from './contracts'

/** Only curated product-facing sections are accepted; never render HTML or commit metadata. */
export function readReleaseNotes(value: unknown): UpdateReleaseNotes | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const notes = value as Record<string, unknown>
  const section = (key: string): string[] => Array.isArray(notes[key])
    ? notes[key].filter((item): item is string => typeof item === 'string' && !!item.trim()).slice(0, 30).map(item => item.trim().slice(0, 1000)) : []
  const result = { features: section('features'), fixes: section('fixes'), notices: section('notices') }
  return Object.values(result).some(items => items.length) ? result : undefined
}
