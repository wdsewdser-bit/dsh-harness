import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync, openSync, closeSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { acquireWindowFileProtection, windowFileProtectionFacts } from '../home/profiles/web/plugins/team-v15-window-file-protection.mjs'
import { controlPlaneFor, resetControlPlaneCache } from '../home/profiles/web/plugins/team-control-plane.mjs'

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'window-os-guard-')),parent=join(root,'protected'),file=join(parent,'cp.json')
  mkdirSync(parent);writeFileSync(file,'original')
  t.after(()=>{resetControlPlaneCache();rmSync(root,{recursive:true,force:true})})
  return {root,parent,file}
}

test('same-process OS guard denies writes, delete, replacement and ancestor rename; release restores writers',t=> {
  const f=fixture(t),before=readFileSync(f.file),guard=acquireWindowFileProtection([f.file])
  try {
    assert.equal(guard.receipt.pid,process.pid)
    assert.ok(guard.receipt.namespace.some(row=>row.path.toLowerCase()===f.parent.toLowerCase()))
    assert.deepEqual(guard.readFile(f.file),before)
    assert.throws(()=>writeFileSync(f.file,'must not write'))
    assert.throws(()=>unlinkSync(f.file))
    const replacement=join(f.parent,'candidate.json');writeFileSync(replacement,'candidate')
    assert.throws(()=>renameSync(replacement,f.file))
    assert.throws(()=>renameSync(f.parent,join(f.root,'moved')))
    const child=spawnSync(process.execPath,['--input-type=module','-e',
      "import fs from 'node:fs'; const [file,parent,moved]=process.argv.slice(1); const results=[]; for(const job of [()=>fs.writeFileSync(file,'foreign'),()=>fs.unlinkSync(file),()=>fs.renameSync(parent,moved)]){try{job();results.push(true)}catch{results.push(false)}} process.stdout.write(JSON.stringify(results))",
      f.file,f.parent,join(f.root,'foreign-moved')],{encoding:'utf8',windowsHide:true,timeout:10000})
    assert.equal(child.status,0,child.stderr)
    assert.deepEqual(JSON.parse(child.stdout),[false,false,false])
    assert.deepEqual(readFileSync(f.file),before)
    assert.equal(guard.assertHeld(),true)
  } finally {guard.release()}
  assert.throws(()=>guard.assertHeld(),/STALE/)
  assert.throws(()=>guard.readFile(f.file),/STALE/)
  writeFileSync(f.file,'after release')
  assert.equal(readFileSync(f.file,'utf8'),'after release')
})

test('a preexisting writable handle blocks guard acquisition, never widens sharing or leaks ancestor handles',t=> {
  const f=fixture(t),fd=openSync(f.file,'r+')
  try {assert.throws(()=>acquireWindowFileProtection([f.file]),/ACQUIRE_FAILED/)}finally{closeSync(fd)}
  renameSync(f.parent,join(f.root,'moved'));renameSync(join(f.root,'moved'),f.parent)
  const guard=acquireWindowFileProtection([f.file]);guard.release()
})

test('guard rejects junction/reparse and missing paths, with no dangling handles after failed acquisition',t=> {
  const f=fixture(t),link=join(f.root,'junction')
  symlinkSync(f.parent,link,'junction')
  assert.throws(()=>acquireWindowFileProtection([join(link,'cp.json')]),/REPARSE/)
  assert.throws(()=>acquireWindowFileProtection([f.file,join(f.parent,'missing.json')]),/ACQUIRE_FAILED/)
  assert.throws(()=>acquireWindowFileProtection(['relative.json']),/PATH_DENIED/)
  renameSync(f.parent,join(f.root,'moved'));renameSync(join(f.root,'moved'),f.parent)
})

test('CP protects the locked hot reference closure, reads actual bytes and excludes the UI panel-cache overlay',async t=> {
  const f=fixture(t),cp=controlPlaneFor('os-cp-'+randomUUID(),{directory:f.parent})
  await cp.mutateHot('fixture/canonical-authority',{},null,state=> {
    state.v12Requirements={version:1,requirements:{r1:{text:'canonical requirement'}},decisions:{}}
    state.v12RoomWake={version:1,inbox:{canonical:{text:'durable wake'}},wakes:{},rooms:{}}
  },{deferMs:0})
  const before=cp.windowSnapshot(),binding=cp.windowFenceFacts().binding
  const lease=await cp.acquireWindowFence(binding,{isolated:true,sessionId:'isolated',protectFiles:true})
  try {
    assert.equal(lease.fileProtection.kind,'windows-share-deny-write-delete-v1')
    assert.ok(lease.fileProtection.files.length>1)
    assert.throws(()=>writeFileSync(cp.file,'{}'))
    const cold=lease.fileProtection.files.find(row=>row.path.includes('.cold-'))
    assert.ok(cold);assert.throws(()=>writeFileSync(cold.path,'{}'))
    writeFileSync(cp.file+'.panel-cache.json',JSON.stringify({inbox:{forged:{text:'must not become authority'}}}))
    const current=cp.windowSnapshot()
    assert.deepEqual(current.v12RoomWake,before.v12RoomWake)
    assert.deepEqual(current.v12Requirements,before.v12Requirements)
    assert.equal(current.revision,before.revision)
    assert.equal(lease.assertHeld(binding),true)
  } finally {await lease.release()}
  await cp.mutateHot('fixture/after-release',{},null,state=>{state.marker='normal writer restored'},{deferMs:0})
  assert.equal(cp.windowSnapshot().marker,'normal writer restored')
})

test('fresh canonical read rejects tampered referenced cold bytes despite warmed caches; failed fence releases all protection',async t=> {
  const f=fixture(t),cp=controlPlaneFor('os-corrupt-'+randomUUID(),{directory:f.parent})
  await cp.mutateHot('fixture/authority',{},null,state=>{state.v12Requirements={version:1,requirements:{r1:{text:'original'}},decisions:{}}},{deferMs:0})
  cp.snapshot({history:true});cp.windowSnapshot()
  const binding=cp.windowFenceFacts().binding,hot=JSON.parse(readFileSync(cp.file,'utf8'))
  const path=cp.file+'.cold-'+hot.v12RequirementsRef.digest+'.json',original=readFileSync(path)
  writeFileSync(path,Buffer.from(original.toString('utf8').replace('original','modified')))
  assert.throws(()=>cp.windowSnapshot(),/hash mismatch/)
  await assert.rejects(cp.acquireWindowFence(binding,{isolated:true,sessionId:'isolated',protectFiles:true}),/hash mismatch|COLD_INTEGRITY/)
  writeFileSync(path,original)
  assert.equal(cp.windowSnapshot().v12Requirements.requirements.r1.text,'original')
})

test('missing reference fails closed rather than treating enumeration or absent optional source as protection',async t=> {
  const f=fixture(t),cp=controlPlaneFor('os-missing-'+randomUUID(),{directory:f.parent})
  await cp.mutateHot('fixture/authority',{},null,state=>{state.v12Requirements={version:1,requirements:{},decisions:{}}},{deferMs:0})
  const binding=cp.windowFenceFacts().binding,hot=JSON.parse(readFileSync(cp.file,'utf8'))
  const path=cp.file+'.cold-'+hot.v12RequirementsRef.digest+'.json',original=readFileSync(path)
  unlinkSync(path)
  await assert.rejects(cp.acquireWindowFence(binding,{isolated:true,sessionId:'isolated',protectFiles:true}))
  writeFileSync(path,original)
  const lease=await cp.acquireWindowFence(binding,{isolated:true,sessionId:'isolated',protectFiles:true})
  await lease.release()
})

test('preexisting writable mapped view cannot outlive write ownership and mutate a protected source',t=> {
  const f=fixture(t),require=createRequire(new URL('../app/package.json',import.meta.url)),koffi=require('koffi'),library=koffi.load('kernel32.dll')
  const create=library.func('__stdcall','CreateFileW','intptr',['str16','uint','uint','void*','uint','uint','intptr'])
  const mapping=library.func('__stdcall','CreateFileMappingW','intptr',['intptr','void*','uint','uint','uint','str16'])
  const view=library.func('__stdcall','MapViewOfFile','void*',['intptr','uint','uint','uint','size_t'])
  const unmap=library.func('__stdcall','UnmapViewOfFile','int',['void*'])
  const close=library.func('__stdcall','CloseHandle','int',['intptr'])
  const handle=create(f.file,0xc0000000,7,null,3,0,0)
  assert.notEqual(handle,-1)
  const section=mapping(handle,null,4,0,0,null),pointer=view(section,2,0,0,0)
  assert.ok(section);assert.ok(pointer);close(handle)
  try {assert.throws(()=>acquireWindowFileProtection([f.file]),/ACQUIRE_FAILED/)}
  finally {unmap(pointer);close(section)}
  const guard=acquireWindowFileProtection([f.file]);guard.release()
})

test('OS capability is explicit Windows NTFS support, not caller-provided verified evidence',()=> {
  const facts=windowFileProtectionFacts()
  assert.equal(facts.supported,true)
  assert.equal(facts.acquisition,'real-OS-handles-required')
  assert.ok(facts.exclusions.includes('power-loss'))
})

test('ancestor handle itself denies DELETE access, independently of a leaf file rename',t=> {
  const f=fixture(t),require=createRequire(new URL('../app/package.json',import.meta.url)),library=require('koffi').load('kernel32.dll')
  const create=library.func('__stdcall','CreateFileW','intptr',['str16','uint','uint','void*','uint','uint','intptr'])
  const close=library.func('__stdcall','CloseHandle','int',['intptr'])
  const guard=acquireWindowFileProtection([f.file])
  try {
    const handle=create(f.parent,0x00010000,7,null,3,0x02000000,0)
    if(handle!==-1 && handle!==-1n && handle!==0)close(handle)
    assert.equal(handle,-1,'ancestor must itself hold deny-DELETE sharing')
  } finally {guard.release()}
  const handle=create(f.parent,0x00010000,7,null,3,0x02000000,0)
  assert.notEqual(handle,-1);close(handle)
})

test('source closure is read after obtaining CP lock and holding its index, not before an async wait',async t=> {
  const f=fixture(t),cp=controlPlaneFor('os-source-'+randomUUID(),{directory:f.parent})
  await cp.mutateHot('fixture/seed',{},null,()=>{}, {deferMs:0})
  const index=join(f.parent,'index.json'),first=join(f.parent,'first.json'),second=join(f.parent,'second.json')
  writeFileSync(first,'first');writeFileSync(second,'second');writeFileSync(index,JSON.stringify({path:first}))
  const binding=cp.windowFenceFacts().binding,older=await cp.acquireWindowFence(binding,{isolated:true,sessionId:'older'})
  let called=0
  const pending=cp.acquireWindowFence(binding,{isolated:true,sessionId:'newer',protectFiles:true,sourceFiles:protection=> {
    called++;protection.add([index])
    return [JSON.parse(protection.readFile(index).toString('utf8')).path]
  }})
  await Promise.resolve();assert.equal(called,0)
  writeFileSync(index,JSON.stringify({path:second}));await older.release()
  const held=await pending
  try {
    assert.equal(called,1)
    assert.ok(held.fileProtection.files.some(row=>row.path===second))
    assert.ok(!held.fileProtection.files.some(row=>row.path===first))
    assert.throws(()=>writeFileSync(second,'must not overwrite current artifact'))
    assert.throws(()=>writeFileSync(index,JSON.stringify({path:first})))
    writeFileSync(first,'unreferenced still writable')
  } finally {await held.release()}
})

test('case-sensitive NTFS objects are never merged by a lowercase held-path cache',t=> {
  const f=fixture(t),sensitive=join(f.root,'case-sensitive');mkdirSync(sensitive)
  const command=spawnSync('fsutil.exe',['file','setCaseSensitiveInfo',sensitive,'enable'],{encoding:'utf8',windowsHide:true,timeout:10000})
  assert.equal(command.status,0,command.stdout+command.stderr)
  const upper=join(sensitive,'A.json'),lower=join(sensitive,'a.json')
  writeFileSync(upper,'upper');writeFileSync(lower,'lower')
  assert.equal(readFileSync(upper,'utf8'),'upper')
  const guard=acquireWindowFileProtection([upper,lower])
  try {
    assert.equal(guard.readFile(upper).toString('utf8'),'upper')
    assert.equal(guard.readFile(lower).toString('utf8'),'lower')
    assert.equal(guard.receipt.files.length,2)
    assert.throws(()=>writeFileSync(upper,'invalid'))
    assert.throws(()=>writeFileSync(lower,'invalid'))
  } finally {guard.release()}
})
