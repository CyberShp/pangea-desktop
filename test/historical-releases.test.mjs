import test from 'node:test'
import assert from 'node:assert/strict'
import { paginate, parseVersion, olderVersion, classifyRelease, assetPair, args, patchName, uniqueReleases } from '../scripts/historical-release-lib.mjs'
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
  assert.equal(classifyRelease({tag_name:'v2.0.9'}, '2.0.10', 'stable').status, 'pending')
  for (const release of [{tag_name:'v2.0.10'}, {tag_name:'v2.1.0'}, {tag_name:'v2.0.9',draft:true}, {tag_name:'bad'}, {tag_name:'2.0.9'}, {tag_name:'v2.0.9-test.1.abcdef0'}]) assert.equal(classifyRelease(release,'2.0.10','stable').status,'unsupported')
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
  const row={version:'2.0.9',status:'verified',patch:patchName('2.0.10','2.0.9'),patch_sha256:'a'.repeat(64)}
  const report={target:'2.0.10', discovery_complete:true, bases:[row,{status:'missing'}]}
  assert.equal(publicationNames('2.0.10',report).length,2)
  for(const status of ['pending','failed','unknown']) assert.throws(()=>publicationNames('2.0.10',{...report,bases:[{...row,status}]}),/unverified/)
  assert.throws(()=>publicationNames('2.0.10',{...report,bases:[{...row,patch:'../x'}]}),/Invalid/)
  assert.throws(()=>publicationNames('2.0.11',report),/Invalid/)
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
