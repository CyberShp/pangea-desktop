import { randomUUID } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import { Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const appRoot = process.env.PANGEA_TEST_APP_ROOT
if (!appRoot) throw new Error('PANGEA_TEST_APP_ROOT is required')
if (process.argv.slice(2).includes('--version')) {
  process.stdout.write('pangea-acp-fixture 1.0\n')
  process.exit(0)
}

const sdkPath = path.join(appRoot, 'node_modules', '@agentclientprotocol', 'sdk', 'dist', 'acp.js')
const acp = await import(pathToFileURL(sdkPath).href)
const scratchTest = process.env.PANGEA_TEST_SCRATCH === '1'

class FixtureAgent {
  constructor(connection) {
    this.connection = connection
    this.sessions = new Set()
    this.turns = new Map()
    this.pending = new Map()
  }

  async initialize() {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: scratchTest } }
  }

  async newSession({ cwd }) {
    const sessionId = randomUUID()
    this.sessions.add(sessionId)
    this.turns.set(sessionId, 0)
    if (scratchTest) await writeFile(path.join(process.env.PANGEA_WORKER_SCRATCH, 'fixture-session.json'), JSON.stringify({ sessionId, cwd }))
    return { sessionId }
  }

  async loadSession({ sessionId, cwd }) {
    const saved = JSON.parse(await readFile(path.join(process.env.PANGEA_WORKER_SCRATCH, 'fixture-session.json'), 'utf8'))
    if (saved.sessionId !== sessionId || saved.cwd !== cwd) throw new Error('fixture session or cwd changed on resume')
    this.sessions.add(sessionId)
    this.turns.set(sessionId, 0)
    return { sessionId }
  }

  async authenticate() { return {} }

  async prompt({ sessionId, prompt }) {
    if (!this.sessions.has(sessionId)) throw new Error(`unknown fixture session: ${sessionId}`)
    const turn = (this.turns.get(sessionId) ?? 0) + 1
    this.turns.set(sessionId, turn)
    const promptText = (prompt ?? []).map(item => item?.type === 'text' ? item.text : '').join('')
    let content = scratchTest && promptText === 'REPORT_SCRATCH'
      ? JSON.stringify({ cwd: process.cwd(), sessionId, env: Object.fromEntries(['TEMP', 'TMP', 'TMPDIR', 'PANGEA_WORKER_SCRATCH', 'PANGEA_TEST_KEEP', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PERMISSION'].map(name => [name, process.env[name]])) })
      : `ACP_BATCH_READY turn=${turn} ${JSON.stringify(process.argv.slice(2))} shell=${process.env.CODEAGENT3_WINDOWS_SHELL_TYPE ?? 'unset'}`
    if (promptText.startsWith('PERMISSION ')) {
      const request = JSON.parse(promptText.slice('PERMISSION '.length))
      const result = await this.connection.requestPermission({ sessionId,
        toolCall: { toolCallId: randomUUID(), title: 'fixture native operation', kind: request.kind, locations: request.locations, rawInput: request.rawInput },
        options: request.options ?? [
          { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
          { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
        ],
      })
      if (request.write && result.outcome.outcome === 'selected' && ['once', 'always'].includes(result.outcome.optionId)) {
        for (const location of request.locations) {
          await mkdir(path.dirname(location.path), { recursive: true })
          await writeFile(location.path, 'fixture native write')
        }
      }
      content = JSON.stringify(result)
    }
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: content },
      },
    })
    if (promptText.includes('WAIT_FOR_CANCEL')) {
      const controller = new AbortController()
      this.pending.set(sessionId, controller)
      await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }))
      this.pending.delete(sessionId)
      return { stopReason: 'cancelled' }
    }
    return { stopReason: 'end_turn' }
  }

  async cancel({ sessionId }) {
    this.pending.get(sessionId)?.abort()
  }
}

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
new acp.AgentSideConnection(connection => new FixtureAgent(connection), stream)
