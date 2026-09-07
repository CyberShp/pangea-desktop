import { randomUUID } from 'node:crypto'
import path from 'node:path'
import process from 'node:process'
import { Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'

const appRoot = process.env.PANGEA_TEST_APP_ROOT
if (!appRoot) throw new Error('PANGEA_TEST_APP_ROOT is required')
if (process.argv.slice(2).includes('--version')) {
  process.stdout.write('pangea-acp-fixture 1.0\n')
  process.exit(0)
}

const sdkPath = path.join(appRoot, 'node_modules', '@agentclientprotocol', 'sdk', 'dist', 'acp.js')
const acp = await import(pathToFileURL(sdkPath).href)

class FixtureAgent {
  constructor(connection) {
    this.connection = connection
    this.sessions = new Set()
    this.turns = new Map()
    this.pending = new Map()
  }

  async initialize() {
    return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: false } }
  }

  async newSession() {
    const sessionId = randomUUID()
    this.sessions.add(sessionId)
    this.turns.set(sessionId, 0)
    return { sessionId }
  }

  async authenticate() { return {} }

  async prompt({ sessionId, prompt }) {
    if (!this.sessions.has(sessionId)) throw new Error(`unknown fixture session: ${sessionId}`)
    const turn = (this.turns.get(sessionId) ?? 0) + 1
    this.turns.set(sessionId, turn)
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `ACP_BATCH_READY turn=${turn} ${JSON.stringify(process.argv.slice(2))}` },
      },
    })
    const promptText = (prompt ?? []).map(item => item?.type === 'text' ? item.text : '').join('')
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
