import test from 'node:test'
import assert from 'node:assert/strict'
import { paginate, parseVersion, olderVersion, classifyRelease, assetPair, args, patchName, uniqueReleases, isSupportedPatchBase } from '../scripts/historical-release-lib.mjs'
import { publicationNames } from '../scripts/publish-release-additions.mjs'
test('history exhausts pagination without a baseline cap', async () => {
  const urls = []
  const rows = await paginate('repos/a/b/releases', url => { urls.push(url); return urls.length < 4 ? Array.from({length:100}, (_, i) => i) : [300] })
  assert.equal(rows.length, 301); assert.match(urls[3], /page=4$/)
})
test('API failures and malformed pages cannot silently truncate history', async () => {
  await assert.rejects(paginate('x', () => { throw new Error('rate limited') }), /rate limited/)
  await assert.rejects(paginate('x', () => ({})), /array/)
})
test('exact supported channel and numeric version ordering', () => {
  assert.equal(parseVersion('2.0.10').channel, 'stable')
  assert.equal(olderVersion('2.0.9', '2.0.10'), true)
  assert.equal(olderVersion('2.0.10', '2.0.9'), false)
  assert.equal(olderVersion('2.0.10', '2.0.10-test.1.abcdef0'), false)
  assert.equal(olderVersion('2.0.10-test.9.abcdef0', '2.0.10-test.10.abcdef0'), true)
  assert.equal(olderVersion('2.0.10-test.10.aaaaaaa', '2.0.10-test.10.bbbbbbb'), false)
  for (const invalid of ['2.0.01','v2.0.1','2.0.1-beta.1','../../x']) assert.equal(parseVersion(invalid), null)
})
test('every release receives explicit compatibility classification', () => {
  assert.equal(classifyRelease({tag_name:'v2.1.10'}, '2.1.11', 'stable').status, 'pending')
  for (const release of [{tag_name:'v2.1.11'}, {tag_name:'v2.2.0'}, {tag_name:'v2.1.10',draft:true}, {tag_name:'bad'}, {tag_name:'2.1.10'}, {tag_name:'v2.1.10-test.1.abcdef0'}]) assert.equal(classifyRelease(release,'2.1.11','stable').status,'unsupported')
})
test('requires exact platform architecture ZIP and checksum pair', () => {
  assert.equal(assetPair([{name:'full.zip'}], 'full.zip'), false)
  assert.equal(assetPair([{name:'full.zip'},{name:'full.zip.sha256'}], 'full.zip'), true)
})
test('strict CLI inputs', () => {
  assert.deepEqual(args(['--mode','backfill']), {mode:'backfill'})
  assert.throws(() => args(['--mode']), /Expected/)
  assert.throws(() => args(['--mode','build','--mode','backfill']), /Duplicate/)
})
test('publication only allows verified exact-name patches and explicit fallback exclusions', () => {
  const row={version:'2.1.10',status:'verified',patch:patchName('2.1.11','2.1.10'),patch_sha256:'a'.repeat(64)}
  const report={target:'2.1.11', discovery_complete:true, bases:[row,{status:'missing'}]}
  assert.equal(publicationNames('2.1.11',report).length,2)
  for(const status of ['pending','failed','unknown']) assert.throws(()=>publicationNames('2.1.11',{...report,bases:[{...row,status}]}),/unverified/)
  assert.throws(()=>publicationNames('2.1.11',{...report,bases:[{...row,patch:'../x'}]}),/Invalid/)
  assert.throws(()=>publicationNames('2.1.12',report),/Invalid/)
})

test('sidecars bind the exact artifact name and complete SHA-256', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const { createHash } = await import('node:crypto')
  const { checkChecksum } = await import('../scripts/historical-release-lib.mjs')
  const root = await mkdtemp(path.join(tmpdir(), 'pangea-checksum-'))
  const file = path.join(root, 'package.zip'), sidecar = `${file}.sha256`
  try {
    await writeFile(file, 'archive'); const hash = createHash('sha256').update('archive').digest('hex')
    await writeFile(sidecar, `${hash}  package.zip\n`)
    assert.equal(await checkChecksum(file, sidecar), hash)
    await writeFile(sidecar, `${hash}  other.zip\n`)
    await assert.rejects(checkChecksum(file,sidecar),/Invalid checksum/)
    await writeFile(sidecar, `${'a'.repeat(64)}  package.zip\n`)
    await assert.rejects(checkChecksum(file,sidecar),/mismatch/)
  } finally { await rm(root,{recursive:true,force:true}) }
})

test('concurrent pagination duplicates do not build a baseline twice and ambiguity fails closed', () => {
  const release = { id: 1, tag_name: 'v1.0.0' }
  assert.deepEqual(uniqueReleases([release, release]), [release])
  assert.throws(() => uniqueReleases([release, { id: 2, tag_name: release.tag_name }]), /Ambiguous/)
  assert.throws(() => uniqueReleases([release, { id: 1, tag_name: 'v1.0.1' }]), /Ambiguous/)
  assert.throws(() => uniqueReleases([{ tag_name: 'v1.0.0' }]), /Invalid/)
})

test('retires every pre-2.1.8 baseline before download eligibility, in both channels', () => {
  for (const version of ['0.1.6', '1.0.3', '1.99.99', '1.99.99-test.999.abcdef0', '2.0.0', '2.0.1', '2.0.6', '2.0.6-test.999.abcdef0', '2.0.7', '2.1.7', '2.1.7-test.999.abcdef0']) {
    assert.equal(isSupportedPatchBase(version), false)
    const channel = parseVersion(version).channel
    const target = channel === 'stable' ? '2.1.9' : '2.1.9-test.1.abcdef0'
    const row = classifyRelease({ tag_name: `v${version}` }, target, channel)
    assert.equal(row.status, 'unsupported')
    assert.match(row.reason, /minimum supported patch baseline 2.1.8/)
  }
  assert.equal(isSupportedPatchBase('2.1.8'), true)
  assert.equal(isSupportedPatchBase('2.1.8-test.1.abcdef0'), true)
  assert.equal(classifyRelease({tag_name:'v2.1.8'}, '2.1.9', 'stable').status, 'pending')
  assert.equal(classifyRelease({tag_name:'v2.1.8-test.1.abcdef0'}, '2.1.9-test.1.abcdef0', 'test').status, 'pending')
})

test('publisher rejects stale reports advertising retired sources despite a verified status', () => {
  for (const version of ['1.0.9', '2.0.0', '2.0.6', '2.0.6-test.99.abcdef0', '2.1.7', '2.1.7-test.99.abcdef0']) {
    assert.throws(() => publicationNames('2.1.9', {
      target:'2.1.9', discovery_complete:true, bases:[{
        version, status:'verified', patch:patchName('2.1.9',version), patch_sha256:'a'.repeat(64)
      }]
    }), /Invalid verified patch record/)
  }
})
