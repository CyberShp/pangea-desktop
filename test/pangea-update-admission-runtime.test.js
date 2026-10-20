import { createServer } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as admissionPlugin from '../packages/dsh-pangea-product/update-admission.js'
import { UpdateAdmission, installUpdateAdmission, UPDATE_ADMISSION_PATH } from '../packages/dsh-pangea-product/update-admission.js'

const TOKEN = 'test-update-token-12345'
const cleanup = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function fixture({ start = async () => ({}) } = {}) {
  const routes = new Map()
  const events = new Map()
  const live = []
  const ownedJobs = new Map()
  const createAgent = () => ({ id: `agent-${live.length}`, status: 'idle', phase: { kind: 'idle' }, inbox: { hasPending: false },
    send: vi.fn(), runMaintenance: vi.fn(job => job()) })
  const apiCall = vi.fn(async request => ({ rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } }))
  const ctx = {
    agents: { list: () => live, create: vi.fn(async () => { const agent = createAgent(); ctx.agents.enter(agent); return { agent } }),
      resume: vi.fn(async () => { const agent = createAgent(); ctx.agents.enter(agent); return { agent } }), enter: agent => { live.push(agent) } },
    jobs: { list: owner => ownedJobs.get(owner?.id ?? '') ?? [], start: vi.fn() },
    subprocess: { live: new Set(), terminals: new Set(), spawn: vi.fn(), spawnTerminal: vi.fn() },
    subagents: { start: vi.fn(start), startContinuable: vi.fn(async () => ({})), followup: vi.fn(async () => ({})) },
    tools: { prepareExecution: vi.fn(async (_input, next) => next()), guard: fn => { events.set('toolGuard', fn); return () => events.delete('toolGuard') } },
    apiProxy: { sessions: { create: apiCall, fork: apiCall, prompt: apiCall, updateQueue: apiCall }, subagents: { prompt: apiCall }, goals: { create: apiCall }, respond: vi.fn() },
    webServer: { match: path => routes.get(path), register: route => { routes.set(route.path, route); return () => routes.delete(route.path) } },
    on: (name, callback) => { events.set(name, callback); return () => events.delete(name) },
    provide: (key, value) => { ctx[key] = value; return () => { delete ctx[key] } },
  }
  const existing = createAgent()
  live.push(existing)
  const installed = installUpdateAdmission(ctx, { requiredParticipants: [] })
  cleanup.push(installed.dispose)
  return { ctx, ...installed, routes, events, ownedJobs, live, existing, apiCall }
}

describe('atomic reversible upgrade admission', () => {
  it('loads and disposes through real Cordis services, preserving nested asynchronous tool failures', async () => {
    const ctx = new Context()
    cleanup.push(() => ctx.fiber.dispose())
    const apiCall = async request => ({ rpcId: request.rpcId, result: { ok: true, value: {} } })
    await ctx.plugin({ name: 'test-carriers', apply(child) {
      child.provide('apiProxy', { sessions: { create: apiCall, fork: apiCall, prompt: apiCall, updateQueue: apiCall },
        subagents: { prompt: apiCall }, goals: { create: apiCall }, respond() {} })
      child.provide('subprocess', { spawn() {}, async spawnTerminal() {} })
    } })
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime, {})
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(LocalJobRegistry, {})
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const originalCreate = ctx.agents[Symbol.for('cordis.original')].create
    const gateFiber = await ctx.plugin(admissionPlugin)
    const admission = ctx.get('pangeaUpdateAdmission')
    expect(admission).toBeDefined()
    admission.registerParticipant('companion', () => false)
    admission.registerParticipant('asset-catalog', () => false)
    const held = deferred()
    let entered
    const entry = new Promise(resolve => { entered = resolve })
    const toolsFiber = await ctx.plugin({ name: 'held-tool', inject: ['tools'], apply(child) {
      child.tools.register({ name: 'held', description: 'test admission', parameters: { type: 'object', properties: {} },
        async execute() { entered(); await held.promise; throw new Error('nested failure') },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] } })
    } })
    const operation = ctx.tools.execute({ name: 'held', callId: 'tool-1', arguments: {}, signal: new AbortController().signal })
    await entry
    expect(() => admission.freeze(TOKEN)).toThrow(/在途/)
    held.resolve()
    const result = await operation
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toContain('nested failure')
    expect(admission.inFlight).toBe(0)
    admission.freeze(TOKEN)
    expect(() => ctx.agents.create({ sessionId: 'new' })).toThrow(/正在准备升级/)
    const response = await fetch(`http://127.0.0.1:${ctx.webServer.port}${UPDATE_ADMISSION_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-pangea-desktop-update': '1' },
      body: JSON.stringify({ action: 'release', token: TOKEN }),
    })
    expect(response.status).toBe(200)
    expect(admission.token).toBeNull()
    await toolsFiber.dispose()
    await gateFiber.dispose()
    expect(ctx.get('pangeaUpdateAdmission')).toBeUndefined()
    expect(ctx.agents[Symbol.for('cordis.original')].create).toBe(originalCreate)
    expect(ctx.webServer.match(UPDATE_ADMISSION_PATH)).toBeUndefined()
  })
  it('refuses pending requests without disturbing them and admits again after rollback', async () => {
    const gate = new UpdateAdmission()
    const pending = deferred()
    const operation = gate.run(() => pending.promise)
    expect(() => gate.freeze(TOKEN)).toThrow(/在途/)
    expect(gate.token).toBeNull()
    expect(gate.run(() => 7)).toBe(7)
    pending.resolve()
    await operation
    expect(gate.freeze(TOKEN)).toEqual({ ok: true, frozen: true, token: TOKEN })
    expect(() => gate.run(() => 0)).toThrow(/正在准备升级/)
    expect(gate.freeze(TOKEN).frozen).toBe(true)
    expect(() => gate.release('different-token')).toThrow(/不能释放/)
    gate.release(TOKEN)
    expect(gate.run(() => 8)).toBe(8)
  })

  it('fails closed when participants are absent or cannot inspect their queue', () => {
    const gate = new UpdateAdmission(() => [], ['assets'])
    expect(() => gate.freeze(TOKEN)).toThrow(/尚未就绪/)
    const dispose = gate.registerParticipant('assets', () => { throw new Error('queue unavailable') })
    expect(() => gate.freeze(TOKEN)).toThrow('queue unavailable')
    expect(gate.token).toBeNull()
    dispose()
    gate.registerParticipant('assets', () => true)
    expect(() => gate.freeze(TOKEN)).toThrow(/assets/)
    expect(gate.token).toBeNull()
  })

  it.each(['running', 'maintenance', 'inbox', 'owned-job'])('detects %s without relying on session.list.running', reason => {
    const { admission, existing, ownedJobs } = fixture()
    if (reason === 'running') existing.status = 'running'
    if (reason === 'maintenance') existing.phase.kind = 'maintenance'
    if (reason === 'inbox') existing.inbox.hasPending = true
    if (reason === 'owned-job') ownedJobs.set(existing.id, [{ status: 'stopping' }])
    expect(() => admission.freeze(TOKEN)).toThrow(/仍有运行/)
    expect(admission.token).toBeNull()
  })

  it('lets the updater close idle resident workers and terminals', () => {
    const { admission, ctx } = fixture()
    ctx.subprocess.live.add({})
    ctx.subprocess.terminals.add({})
    expect(admission.freeze(TOKEN).frozen).toBe(true)
  })

  it('tracks detached ACP results and gates continuePrompt on already returned reusable workers', async () => {
    const provider = deferred()
    const turn = deferred()
    const continuePrompt = vi.fn(() => turn.promise)
    const { ctx, admission: gate } = fixture({ start: async () => ({ result: provider.promise, continuePrompt }) })
    const run = await ctx.subagents.start('acp', {})
    expect(() => gate.freeze(TOKEN)).toThrow(/执行器回合/)
    provider.resolve({ stopReason: 'completed' })
    await provider.promise
    gate.freeze(TOKEN)
    expect(() => run.continuePrompt([])).toThrow(/正在准备升级/)
    expect(continuePrompt).not.toHaveBeenCalled()
    gate.release(TOKEN)
    const continued = run.continuePrompt([])
    expect(() => gate.freeze(TOKEN)).toThrow(/在途/)
    turn.resolve({ stopReason: 'completed' })
    await continued
    expect(gate.freeze(TOKEN).frozen).toBe(true)
  })

  it('guards existing/new native agents, ACP, continuations, jobs, subprocesses and direct API calls', async () => {
    const { admission, ctx, existing, events, apiCall } = fixture()
    const { agent: newer } = await ctx.agents.create()
    admission.freeze(TOKEN)
    for (const run of [
      () => existing.send({}), () => newer.send({}), () => existing.runMaintenance(() => {}),
      () => ctx.agents.create(), () => ctx.agents.resume(),
      () => ctx.subagents.start('pangea-nga', {}), () => ctx.subagents.startContinuable({}),
      () => ctx.subagents.followup({}, 'child', []), () => ctx.jobs.start({}),
      () => ctx.subprocess.spawn({}), () => ctx.subprocess.spawnTerminal({}),
      () => ctx.tools.prepareExecution({}, () => {}), () => events.get('tools/execute')({}, () => {}),
    ]) expect(run).toThrow(/正在准备升级/)
    expect(events.get('toolGuard')({})).toMatch(/正在准备升级/)
    const blocked = await ctx.apiProxy.sessions.prompt({ rpcId: 'direct', payload: {} })
    expect(blocked.result).toMatchObject({ ok: false, error: { details: { reason: 'PANGEA_UPDATE_FROZEN' } } })
    expect(apiCall).not.toHaveBeenCalled()
    admission.release(TOKEN)
    expect((await ctx.apiProxy.sessions.prompt({ rpcId: 'direct', payload: {} })).result.ok).toBe(true)
    existing.send({})
  })

  it('covers the installed RPC carrier used by desktop and mobile, with API created before the gate', async () => {
    const { ctx, admission, apiCall } = fixture()
    const carrier = toFetchHandler(ctx.apiProxy)
    admission.freeze(TOKEN)
    const rpc = () => carrier.fetch('http://localhost/api/session.prompt', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'mobile-rpc', method: 'session.prompt',
        payload: { sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: 'continue' }] } }),
    })
    const body = await (await rpc()).json()
    expect(body.result.ok).toBe(false)
    expect(JSON.stringify(body)).toContain('PANGEA_UPDATE_FROZEN')
    expect(apiCall).not.toHaveBeenCalled()
    admission.release(TOKEN)
    expect((await (await rpc()).json()).result.ok).toBe(true)
  })

  it('blocks raw plugin HTTP registered before or after installation and authenticates control requests', async () => {
    const { ctx, admission } = fixture()
    const work = vi.fn((_req, res) => { res.writeHead(200); res.end('started') })
    ctx.webServer.register({ path: '/api/pangea-companion/workbench', handler: work })
    const server = createServer((req, res) => {
      const route = ctx.webServer.match(new URL(req.url, 'http://localhost').pathname)
      Promise.resolve(route.handler(req, res)).catch(error => { res.writeHead(500); res.end(error.message) })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    cleanup.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
    const base = `http://127.0.0.1:${server.address().port}`
    const control = (action, extra = {}) => fetch(base + UPDATE_ADMISSION_PATH, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-pangea-desktop-update': '1', ...extra },
      body: JSON.stringify({ action, token: TOKEN }),
    })
    expect((await control('freeze', { origin: 'http://attacker.invalid' })).status).toBe(403)
    expect(admission.token).toBeNull()
    expect((await control('freeze')).status).toBe(200)
    expect((await fetch(base + '/api/pangea-companion/workbench', { method: 'POST' })).status).toBe(503)
    ctx.webServer.register({ path: '/api/pangea-asset-catalog/assets', handler: work })
    expect((await fetch(base + '/api/pangea-asset-catalog/assets', { method: 'POST' })).status).toBe(503)
    expect(work).not.toHaveBeenCalled()
    expect((await control('release')).status).toBe(200)
    expect((await fetch(base + '/api/pangea-companion/workbench', { method: 'POST' })).status).toBe(200)
    expect(work).toHaveBeenCalledOnce()
  })
})
