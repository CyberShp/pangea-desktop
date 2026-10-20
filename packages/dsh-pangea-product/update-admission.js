// Product-owned, reversible upgrade admission. The installed Harness does not
// expose a reversible global shutdown gate; its closeInitiators() is terminal.
export const name = 'pangea-update-admission'
export const inject = ['webServer', 'apiProxy', 'agents', 'subagents', 'jobs', 'tools', 'subprocess']
export const UPDATE_ADMISSION_PATH = '/api/pangea-product/update-admission'
export const FROZEN_MESSAGE = '正在准备升级，暂时不能新建、继续任务或执行工具；升级取消后可重试。'

const original = value => value?.[Symbol.for('cordis.original')] ?? value
const terminalJobs = new Set(['completed', 'killed', 'failed'])
const safeHttp = new Set([
  '/api/session.list', '/api/session.history', '/api/session.models',
  '/api/session.cancel', '/api/subagent.cancel', '/api/workspace.list',
  '/api/events.mux', '/api/events.host',
])

function failure(code, message) { return Object.assign(new Error(message), { code }) }

export class UpdateAdmission {
  constructor(checkBusy = () => [], requiredParticipants = []) {
    this.checkBusy = checkBusy
    this.requiredParticipants = requiredParticipants
    this.participants = new Map()
    this.inFlight = 0
    this.token = null
  }
  assertOpen() {
    if (this.token) throw failure('PANGEA_UPDATE_FROZEN', FROZEN_MESSAGE)
  }
  // Keep synchronous APIs synchronous, and keep admission until async work
  // settles. Nested calls are deliberately counted too: zero is authoritative.
  run(operation) {
    this.assertOpen()
    this.inFlight++
    let result
    try { result = operation() } catch (error) { this.inFlight--; throw error }
    if (result && typeof result.then === 'function') {
      return Promise.resolve(result).finally(() => { this.inFlight-- })
    }
    this.inFlight--
    return result
  }
  registerParticipant(id, checkBusy) {
    if (this.participants.has(id)) throw new Error(`Duplicate upgrade participant: ${id}`)
    this.participants.set(id, checkBusy)
    return () => { if (this.participants.get(id) === checkBusy) this.participants.delete(id) }
  }
  freeze(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(token)) {
      throw failure('PANGEA_UPDATE_BAD_TOKEN', '升级锁标识无效。')
    }
    if (this.token === token) return { ok: true, frozen: true, token }
    if (this.token) throw failure('PANGEA_UPDATE_BUSY', '另一项升级正在准备，请等待其完成。')
    // No await between closing admission, inspecting every owner and rollback.
    // A busy rejection cannot interrupt any existing task in this JS turn.
    this.token = token
    try {
      const missing = this.requiredParticipants.filter(id => !this.participants.has(id))
      if (missing.length) throw failure('PANGEA_UPDATE_UNAVAILABLE', `升级任务检查尚未就绪：${missing.join(', ')}。请重启工作台后重试。`)
      const busy = this.inFlight ? ['在途请求或工具操作'] : []
      busy.push(...this.checkBusy())
      for (const [id, check] of this.participants) if (check()) busy.push(id)
      if (busy.length) throw failure('PANGEA_UPDATE_BUSY', `当前仍有运行、排队或收尾中的任务，请结束后再升级（${[...new Set(busy)].join('、')}）。`)
      return { ok: true, frozen: true, token }
    } catch (error) {
      this.token = null
      throw error
    }
  }
  release(token) {
    if (this.token && this.token !== token) throw failure('PANGEA_UPDATE_BAD_TOKEN', '不能释放另一项升级的任务锁。')
    this.token = null
    return { ok: true, frozen: false }
  }
}

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

export function createControlHandler(admission) {
  return async (req, res) => {
    const address = req.socket?.remoteAddress
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)
      || req.headers.origin || req.headers['x-pangea-desktop-update'] !== '1') {
      return json(res, 403, { ok: false, code: 'PANGEA_UPDATE_FORBIDDEN', message: '仅桌面宿主可准备升级。' })
    }
    if (req.method !== 'POST' || req.headers['content-type']?.split(';', 1)[0] !== 'application/json') {
      return json(res, 400, { ok: false, code: 'PANGEA_UPDATE_BAD_REQUEST', message: '升级请求格式无效。' })
    }
    try {
      let body = ''
      for await (const chunk of req) {
        body += chunk.toString()
        if (body.length > 2048) throw failure('PANGEA_UPDATE_BAD_REQUEST', '升级请求过大。')
      }
      const input = JSON.parse(body)
      if (!['freeze', 'release'].includes(input.action)) throw failure('PANGEA_UPDATE_BAD_REQUEST', '未知升级操作。')
      json(res, 200, admission[input.action](input.token))
    } catch (error) {
      json(res, error.code === 'PANGEA_UPDATE_BUSY' ? 409 : 400, {
        ok: false, code: error.code ?? 'PANGEA_UPDATE_UNAVAILABLE', message: error.message,
      })
    }
  }
}

// Wrap the actual service object, preserving Cordis's scoped `this` receiver.
// Carriers resolve apiProxy methods at invocation, so existing browser/mobile
// connections and direct in-process calls all see the same admission boundary.
export function installUpdateAdmission(ctx, { requiredParticipants = ['companion', 'asset-catalog'] } = {}) {
  const agents = original(ctx.agents)
  const jobs = original(ctx.jobs)
  const subprocess = original(ctx.subprocess)
  const disposers = []
  const attached = new WeakSet()
  const runningSubagents = new Set()
  const admission = new UpdateAdmission(() => {
    const live = agents.list()
    const busy = []
    if (live.some(agent => agent.status !== 'idle'
      || (agent.phase && agent.phase.kind !== 'idle') || agent.inbox?.hasPending)) busy.push('分析会话')
    // Include a stopping job whose owner has already left the agent registry.
    // The packaged LocalJobRegistry exposes its complete store; alternate
    // implementations are queried through every currently attached owner.
    const snapshots = jobs.store instanceof Map
      ? [...jobs.store.values()] : [jobs.list(), ...live.map(agent => jobs.list(agent))].flat()
    if (snapshots.some(job => !terminalJobs.has(job.status))) busy.push('后台作业')
    if (runningSubagents.size) busy.push('执行器回合')
    // Idle reusable ACP workers and idle terminals are not work. The updater
    // owns their verified shutdown; active work is represented by agents,
    // jobs, participants or an admitted tool/request, not process existence.
    return busy
  }, requiredParticipants)
  function wrap(target, key, make, required = true) {
    target = original(target)
    const previous = target?.[key]
    if (typeof previous !== 'function') {
      if (required) throw new Error(`Upgrade admission requires ${key}()`)
      return
    }
    const descriptor = Object.getOwnPropertyDescriptor(target, key)
    const replacement = make(previous)
    Object.defineProperty(target, key, { configurable: true, writable: true, value: replacement })
    disposers.push(() => {
      if (target[key] !== replacement) return
      if (descriptor) Object.defineProperty(target, key, descriptor)
      else delete target[key]
    })
  }
  const guard = previous => function (...args) { return admission.run(() => previous.apply(this, args)) }
  function attach(agent) {
    agent = original(agent)
    if (attached.has(agent)) return
    attached.add(agent)
    wrap(agent, 'send', guard)
    wrap(agent, 'runMaintenance', guard, false)
  }
  try {
    for (const key of ['create', 'resume']) wrap(agents, key, guard)
    wrap(agents, 'enter', previous => function (agent, ...args) {
      return admission.run(() => { attach(agent); return previous.call(this, agent, ...args) })
    })
    for (const agent of agents.list()) attach(agent)
    wrap(ctx.subagents, 'start', previous => function (...args) {
      return admission.run(async () => {
        const run = await previous.apply(this, args)
        // A one-shot remote run need not have a native Agent or a jobs record.
        // Its published result, rather than its process lifetime, owns busy.
        if (run?.result && typeof run.result.then === 'function') {
          runningSubagents.add(run)
          Promise.resolve(run.result).then(() => runningSubagents.delete(run), () => runningSubagents.delete(run))
        }
        wrap(run, 'continuePrompt', guard, false)
        return run
      })
    })
    for (const key of ['startContinuable', 'followup']) wrap(ctx.subagents, key, guard)
    wrap(jobs, 'start', guard)
    for (const key of ['spawn', 'spawnTerminal']) wrap(subprocess, key, guard)
    // This also covers a pending tool approval before tools/execute begins.
    wrap(ctx.tools, 'prepareExecution', guard)
    disposers.push(ctx.tools.guard(() => admission.token ? FROZEN_MESSAGE : undefined))
    disposers.push(ctx.on('tools/execute', (_exec, next) => admission.run(next)))
    for (const [domain, methods] of [
      ['sessions', ['create', 'fork', 'prompt', 'updateQueue']],
      ['subagents', ['prompt']],
      ['goals', ['create']],
    ]) for (const key of methods) wrap(ctx.apiProxy[domain], key, previous => function (request, ...args) {
      try { return admission.run(() => previous.call(this, request, ...args)) } catch (error) {
        if (error.code !== 'PANGEA_UPDATE_FROZEN') throw error
        return Promise.resolve({ rpcId: request.rpcId, result: { ok: false, error: {
          code: 'agent-busy', message: FROZEN_MESSAGE, details: { reason: error.code },
        } } })
      }
    })
    wrap(ctx.apiProxy, 'respond', guard)
    wrap(ctx.webServer, 'match', previous => function (pathname) {
      const route = previous.call(this, pathname)
      if (!route || pathname === UPDATE_ADMISSION_PATH || !pathname.startsWith('/api/')) return route
      return { ...route, handler: (req, res) => {
        if (safeHttp.has(pathname)) return route.handler(req, res)
        try { return admission.run(() => route.handler(req, res)) } catch (error) {
          if (error.code !== 'PANGEA_UPDATE_FROZEN') throw error
          return json(res, 503, { ok: false, status: 'error', code: error.code, message: error.message, error: error.message })
        }
      } }
    })
    disposers.push(ctx.webServer.register({ kind: 'exact', path: UPDATE_ADMISSION_PATH, handler: createControlHandler(admission) }))
    disposers.push(ctx.provide('pangeaUpdateAdmission', admission))
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  const dispose = () => { for (const cleanup of disposers.reverse()) cleanup() }
  return { admission, dispose }
}

export function apply(ctx) {
  const { dispose } = installUpdateAdmission(ctx)
  ctx.effect(() => dispose, 'PANGEA reversible update admission')
}
