import { mkdtemp, mkdir, writeFile, chmod, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os'; import path from 'node:path'; import {createHash} from 'node:crypto'; import {spawnSync} from 'node:child_process'; import assert from 'node:assert/strict'; import test from 'node:test'; import { fileURLToPath } from 'node:url';
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
test('publication CLI preserves immutable assets and completes missing pairs', { skip: process.platform === 'win32' ? 'POSIX fake gh executable; Windows workflow separately exercises real gh' : false }, async () => {
const root=await mkdtemp(path.join(tmpdir(),'publisher-review-')); const hash=x=>createHash('sha256').update(x).digest('hex');
try {
 const bin=path.join(root,'bin'); await mkdir(bin); const gh=path.join(bin,'gh');
 await writeFile(gh,`#!/usr/bin/env node
const fs=require('fs'),p=require('path');const a=process.argv.slice(2),s=JSON.parse(fs.readFileSync(process.env.FIXTURE));
if(a[0]==='api'){if(a[1].includes('/tags/')) console.log(JSON.stringify({id:1,tag_name:'v2.0.21',draft:false})); else console.log(JSON.stringify(Object.keys(s.remote).map(name=>({name}))));}
else if(a[1]==='download'){const n=a[a.indexOf('--pattern')+1];fs.copyFileSync(p.join(s.store,n),p.join(a[a.indexOf('--dir')+1],n));}
else if(a[1]==='upload'){fs.appendFileSync(s.log,p.basename(a[3])+'\\n');}else process.exit(3);
`); await chmod(gh,0o700);
 for(const kind of ['new','same','conflict','zip-only','checksum-only']){
 const dir=path.join(root,kind),store=path.join(dir,'remote'),local=path.join(dir,'local');await mkdir(store,{recursive:true});await mkdir(local);
 const full='pangea-desktop-2.0.21-windows-x64-portable.zip',patch='pangea-desktop-2.0.21-from-2.0.20-windows-x64.patch.zip';
 const contents={[full]:'full',[full+'.sha256']:`${hash('full')}  ${full}\n`,[patch]:'patch',[patch+'.sha256']:`${hash('patch')}  ${patch}\n`};
 const report={target:'2.0.21',discovery_complete:true,full_fallback:{name:full,sha256:hash('full')},bases:[{version:'2.0.20',status:'verified',patch,patch_sha256:hash('patch')}]};const bytes=JSON.stringify(report),rn=`pangea-desktop-2.0.21-patch-report-${hash(bytes).slice(0,12)}.json`; contents[rn]=bytes;
 for(const [n,b]of Object.entries(contents)){await writeFile(path.join(local,n),b);await writeFile(path.join(store,n),kind==='conflict'&&n===patch?'BAD':b)}
 const remote=Object.fromEntries((kind==='new'?[full,full+'.sha256']:kind==='zip-only'?[full,full+'.sha256',patch]:kind==='checksum-only'?[full,full+'.sha256',patch+'.sha256']:Object.keys(contents)).map(n=>[n,true]));const log=path.join(dir,'uploads');await writeFile(log,'');const fixture=path.join(dir,'fixture.json');await writeFile(fixture,JSON.stringify({remote,store,log}));
 const r=spawnSync(process.execPath,['scripts/publish-release-additions.mjs','--version','2.0.21','--directory',local],{cwd:repositoryRoot,encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH,GITHUB_REPOSITORY:'a/b',FIXTURE:fixture}});const uploads=(await readFile(log,'utf8')).trim();
 if(kind==='conflict'){assert.notEqual(r.status,0,r.stdout+r.stderr);assert.equal(uploads,'');assert.match(r.stderr,/Immutable asset conflict/)}else{assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(uploads?uploads.split('\n').length:0,kind==='new'?3:kind.endsWith('-only')?2:0)}console.log('PASS publisher '+kind);
 }
}finally{await rm(root,{recursive:true,force:true})}

});
