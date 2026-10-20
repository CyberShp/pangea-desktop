// Normalize both saved Runtime settings and direct provider configuration, so
// existing installations receive the same non-interactive project trust flag.
export function normalizeAcpLaunchArgs(providerName, args) {
  if (!Array.isArray(args) || args.some(item => typeof item !== 'string')) {
    throw new Error(`${providerName} ACP args must be strings`)
  }
  const normalized = [...args]
  if (providerName !== 'pangea-nga' && providerName !== 'pangea-codeagent') return normalized
  const flag = '--skip-safe-check'
  const separator = normalized.indexOf('--')
  const options = separator < 0 ? normalized : normalized.slice(0, separator)
  const positional = separator < 0 ? [] : normalized.slice(separator)
  return [...options.filter(arg => arg !== flag), flag, ...positional]
}
