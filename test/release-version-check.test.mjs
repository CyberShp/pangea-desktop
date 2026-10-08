import assert from 'node:assert/strict'
import test from 'node:test'
import { assertReleaseVersionAvailable } from '../scripts/assert-release-version-available.mjs'

const input = { repository: 'CyberShp/pangea-desktop', version: '2.0.1', token: 'test-secret' }
function fixture(statuses) {
  const calls = []
  const cancelled = []
  const request = async (url, options) => {
    const index = calls.length
    calls.push({ url, options })
    assert.ok(index < statuses.length, 'unexpected extra API request')
    const status = statuses[index]
    if (status instanceof Error) throw status
    return { status, body: { cancel: async () => { cancelled.push(index) } } }
  }
  return { calls, cancelled, request }
}

test('a readable repository with no release and no tag permits a new exact version', async () => {
  const f = fixture([200, 404, 404])
  assert.deepEqual(await assertReleaseVersionAvailable({ ...input, request: f.request }), {
    repository: input.repository, tag: 'v2.0.1', available: true,
  })
  assert.deepEqual(f.calls.map(call => call.url), [
    'https://api.github.com/repos/CyberShp/pangea-desktop',
    'https://api.github.com/repos/CyberShp/pangea-desktop/releases/tags/v2.0.1',
    'https://api.github.com/repos/CyberShp/pangea-desktop/git/ref/tags/v2.0.1',
  ])
  for (const { options } of f.calls) {
    assert.equal(options.method, 'GET')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, 'Bearer test-secret')
    assert.ok(options.signal instanceof AbortSignal)
  }
  assert.deepEqual(f.cancelled, [0, 1, 2])
})

for (const [release, tag] of [[200, 200], [200, 404], [404, 200]]) {
  test(`blocks an occupied version without deleting or overwriting it (${release}/${tag})`, async () => {
    const f = fixture([200, release, tag])
    await assert.rejects(assertReleaseVersionAvailable({ ...input, version: '2.0.0', request: f.request }), /Release version already exists: v2\.0\.0/)
    assert.ok(f.calls.every(call => call.options.method === 'GET'))
  })
}

for (const status of [401, 403, 404, 429, 500]) {
  test(`repository access failure HTTP ${status} cannot be mistaken for an unused version`, async () => {
    const f = fixture([status])
    await assert.rejects(assertReleaseVersionAvailable({ ...input, request: f.request }), new RegExp(`HTTP ${status}`))
    assert.equal(f.calls.length, 1)
  })
}

for (const stage of ['release', 'tag']) {
  for (const status of [401, 403, 429, 500]) {
    test(`${stage} lookup HTTP ${status} fails closed`, async () => {
      const f = fixture(stage === 'release' ? [200, status] : [200, 404, status])
      await assert.rejects(assertReleaseVersionAvailable({ ...input, request: f.request }), new RegExp(`HTTP ${status}`))
    })
  }
}

for (const stage of [0, 1, 2]) {
  test(`network error or timeout at lookup ${stage} blocks publication without leaking credentials`, async () => {
    const f = fixture([...([200, 404].slice(0, stage)), new Error('test-secret must not be logged')])
    await assert.rejects(assertReleaseVersionAvailable({ ...input, request: f.request }), error => {
      assert.match(error.message, /network failure or timeout/)
      assert.doesNotMatch(error.message, /test-secret/)
      return true
    })
  })
}

test('invalid input fails before network access', async () => {
  for (const patch of [
    { repository: '' }, { repository: '../repo/name' }, { token: '' },
    { version: '02.0.1' }, { version: 'v2.0.1' }, { version: '2.0.1-test.1' },
    { apiUrl: 'http://api.github.com' }, { apiUrl: 'https://user:secret@api.github.com' },
  ]) {
    const f = fixture([])
    await assert.rejects(assertReleaseVersionAvailable({ ...input, ...patch, request: f.request }))
    assert.equal(f.calls.length, 0)
  }
})

test('GitHub Enterprise API base paths are retained', async () => {
  const f = fixture([200, 404, 404])
  await assertReleaseVersionAvailable({ ...input, apiUrl: 'https://github.example/api/v3/', request: f.request })
  assert.ok(f.calls.every(call => call.url.startsWith('https://github.example/api/v3/repos/')))
})
