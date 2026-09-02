import { pathToFileURL } from 'node:url'

// On macOS Harness runs inside an Electron utility process (TCC responsibility
// isolation), so `process.execPath` and `argv0` point at the Electron helper
// instead of a Node binary. Plugins re-invoke the dsh CLI through the
// executable running them — dsh-market forwards `process.execArgv` with it —
// and without Node mode that child boots as an Electron app, where the leading
// `--expose-internals` shifts argv and the CLI answers "--profile <name> is
// required" instead of installing. Declaring it here, after this process has
// already parsed the Chromium switches it was launched with, marks only the
// children as Node processes. Bundled-Node hosts (Windows, Linux) skip it.
if (process.versions.electron !== undefined) {
  process.env.ELECTRON_RUN_AS_NODE = '1'
}

const [dshEntryPath, ...dshArguments] = process.argv.slice(2)

function report(label, value) {
  process.stderr.write(`[harness-node] ${label}: ${value}\n`)
}

function describeError(error, seen = new Set()) {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) {
    return String(error)
  }
  if (seen.has(error)) return '[circular error]'
  seen.add(error)

  const lines = [error.stack ?? error.message ?? String(error)]
  if (error.cause !== undefined) {
    lines.push(`Caused by: ${describeError(error.cause, seen)}`)
  }
  if (Array.isArray(error.errors)) {
    for (const [index, member] of error.errors.entries()) {
      lines.push(`Aggregate member ${index + 1}: ${describeError(member, seen)}`)
    }
  }
  return lines.join('\n')
}

process.on('uncaughtException', (error) => report('uncaught exception', describeError(error)))
process.on('unhandledRejection', (error) => report('unhandled rejection', describeError(error)))

process.stdout.write(
  `[harness-node] runtime node=${process.version} platform=${process.platform} arch=${process.arch}\n`
)
process.stdout.write(`[harness-node] execPath=${process.execPath}\n`)
process.stdout.write(`[harness-node] cwd=${process.cwd()}\n`)
process.stdout.write(`[harness-node] DSH_HOME=${process.env.DSH_HOME ?? ''}\n`)

if (!dshEntryPath) {
  report('startup error', 'missing DSH entry path')
  process.exitCode = 1
} else {
  process.stdout.write(`[harness-node] loading=${dshEntryPath}\n`)
  process.argv = [process.execPath, dshEntryPath, ...dshArguments]
  try {
    await import(pathToFileURL(dshEntryPath).href)
    process.stdout.write('[harness-node] DSH entry loaded\n')
  } catch (error) {
    report('DSH entry failed', describeError(error))
    process.exitCode = 1
  }
}
