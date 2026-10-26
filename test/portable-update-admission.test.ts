import { createServer } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { acquirePortableUpdateAdmission } from '../src/main/update/portable-update-admission'

const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))) })

async function endpoint(failFreeze: boolean) {
  const actions: Array<{ action: string; token: string }> = []
  const server = createServer(async (request, response) => {
    expect(request.headers['x-pangea-desktop-update']).toBe('1')
    expect(request.headers.origin).toBeUndefined()
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    actions.push(body)
    response.setHeader('content-type', 'application/json')
    if (failFreeze && body.action === 'freeze') {
      response.writeHead(409).end(JSON.stringify({ ok: false, message: '仍有任务运行' }))
    } else response.end(JSON.stringify({ ok: true, frozen: body.action === 'freeze', token: body.token }))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { url: `http://127.0.0.1:${address.port}`, actions }
}

it('holds admission after a successful freeze until explicitly released with the same token', async () => {
  const f = await endpoint(false)
  const release = await acquirePortableUpdateAdmission(f.url)
  expect(f.actions.map(item => item.action)).toEqual(['freeze'])
  await release()
  expect(f.actions.map(item => item.action)).toEqual(['freeze', 'release'])
  expect(f.actions[1]!.token).toBe(f.actions[0]!.token)
})

it('releases a possibly accepted freeze after an unsuccessful handshake', async () => {
  const f = await endpoint(true)
  await expect(acquirePortableUpdateAdmission(f.url)).rejects.toThrow('仍有任务运行')
  expect(f.actions.map(item => item.action)).toEqual(['freeze', 'release'])
  expect(f.actions[1]!.token).toBe(f.actions[0]!.token)
})

it('sends explicit force-stop and preserves the busy code for the force button', async () => {
  const actions: string[] = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    actions.push(body.action)
    if (body.action === 'freeze') res.writeHead(409).end(JSON.stringify({ ok: false, code: 'PANGEA_UPDATE_BUSY', message: 'busy' }))
    else res.end(JSON.stringify({ ok: true, frozen: body.action === 'force-stop', token: body.token }))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  await expect(acquirePortableUpdateAdmission(url)).rejects.toMatchObject({ code: 'PANGEA_UPDATE_BUSY' })
  const release = await acquirePortableUpdateAdmission(url, true)
  await release()
  expect(actions).toEqual(['freeze', 'release', 'force-stop', 'release'])
})
