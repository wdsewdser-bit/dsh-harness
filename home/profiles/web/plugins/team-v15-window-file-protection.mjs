import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, parse, resolve } from 'node:path'

const fail = (code, detail) => { throw Object.assign(new Error(code), { code, detail }) }
const sha = value => createHash('sha256').update(value).digest('hex')
const require = createRequire(new URL('../../../../app/package.json', import.meta.url))
let api
function win32() {
  if (api) return api
  const library = require('koffi').load('kernel32.dll')
  const fn = (name, returns, args) => library.func('__stdcall', name, returns, args)
  api = {
    create: fn('CreateFileW','intptr',['str16','uint','uint','void*','uint','uint','intptr']),
    close: fn('CloseHandle','int',['intptr']),
    info: fn('GetFileInformationByHandle','int',['intptr','void*']),
    finalPath: fn('GetFinalPathNameByHandleW','uint',['intptr','void*','uint','uint']),
    volume: fn('GetVolumeInformationW','int',['str16','void*','uint','void*','void*','void*','void*','uint']),
    seek: fn('SetFilePointerEx','int',['intptr','int64','void*','uint']),
    read: fn('ReadFile','int',['intptr','void*','uint','void*','void*']),
    error: fn('GetLastError','uint',[]),
  }
  return api
}
export function windowFileProtectionFacts() {
  let supported = false
  if(process.platform==='win32') { try { win32(); supported=true } catch {} }
  return {kind:'windows-share-deny-write-delete-v1',supported,
    scope:'same-process-local-NTFS-files-and-ancestor-handles',acquisition:'real-OS-handles-required',
    exclusions:['kernel-or-volume-modification','power-loss']}
}
// Preserve case-sensitive NTFS names; aliases may be conservatively refused.
const normalized = path => resolve(path).replace(/^[a-z]:/,drive=>drive.toUpperCase())
const ancestors = path => {
  const rows=[]
  for(let cursor=dirname(path);;cursor=dirname(cursor)) { rows.unshift(cursor);if(dirname(cursor)===cursor)break }
  return rows
}

/** Synchronous Win32 calls keep handles in the same process as commit. Every
 * ancestor omits DELETE sharing; leaf handles omit WRITE and DELETE sharing. */
// How much one commit may hold. A real Team's control plane references thousands of cold files (6,477 files and 51MB for
// a 30-task Team after three hours); the first limits here were sized for the isolated trials and refused every real fold.
const MAX_ENTRIES = 65536, MAX_FILES_PER_ADD = 65536, MAX_TOTAL_BYTES = 4294967296, MAX_FILE_BYTES = 268435456

export function acquireWindowFileProtection(paths) {
  if(!windowFileProtectionFacts().supported)fail('WINDOW_FILE_PROTECTION_UNAVAILABLE')
  const api=win32(),entries=new Map(),volumes=new Set()
  let released=false,totalBytes=0
  function describe(handle,path,directory) {
    const buffer=Buffer.alloc(52),final=Buffer.alloc(65536)
    if(!api.info(handle,buffer))fail('WINDOW_FILE_PROTECTION_HANDLE_INVALID',api.error())
    const attrs=buffer.readUInt32LE(0)
    if(attrs&0x400 || !!(attrs&0x10)!==directory)fail('WINDOW_FILE_PROTECTION_REPARSE_DENIED')
    const length=api.finalPath(handle,final,final.length/2,0)
    if(!length || length>=final.length/2)fail('WINDOW_FILE_PROTECTION_FINAL_PATH_UNAVAILABLE',api.error())
    const finalPath=final.toString('utf16le',0,length*2).replace(/^\\\\\?\\/,'')
    if(normalized(finalPath)!==normalized(path))fail('WINDOW_FILE_PROTECTION_IDENTITY_CHANGED')
    const identity=[buffer.readUInt32LE(28),buffer.readUInt32LE(44),buffer.readUInt32LE(48)].join(':')
    const size=buffer.readUInt32LE(32)*4294967296+buffer.readUInt32LE(36)
    if(!directory && (!Number.isSafeInteger(size)||size>MAX_FILE_BYTES))fail('WINDOW_FILE_PROTECTION_BUDGET')
    return {identity,size,finalPath}
  }
  function open(path,directory) {
    const key=normalized(path)
    if(entries.has(key))return entries.get(key)
    if(entries.size>=MAX_ENTRIES)fail('WINDOW_FILE_PROTECTION_BUDGET')
    const handle=api.create(path,directory?0x81:0x80000000,directory?3:1,null,3,0x00200000|(directory?0x02000000:0),0)
    if(handle===-1||handle===-1n||handle===0)fail('WINDOW_FILE_PROTECTION_ACQUIRE_FAILED',{path,win32:api.error()})
    try {
      const description=describe(handle,path,directory),entry={path,handle,directory,...description}
      entries.set(key,entry);return entry
    } catch(error) {api.close(handle);throw error}
  }
  function readFile(path) {
    if(released)fail('WINDOW_FILE_PROTECTION_STALE')
    const entry=entries.get(normalized(path))
    if(!entry||entry.directory)fail('WINDOW_FILE_PROTECTION_UNHELD_SOURCE')
    const description=describe(entry.handle,entry.path,false)
    if(description.identity!==entry.identity||description.size!==entry.size)fail('WINDOW_FILE_PROTECTION_IDENTITY_CHANGED')
    const buffer=Buffer.alloc(entry.size),count=Buffer.alloc(4)
    if(!api.seek(entry.handle,0,null,0)||!api.read(entry.handle,buffer,buffer.length,count,null)
      ||count.readUInt32LE(0)!==buffer.length)fail('WINDOW_FILE_PROTECTION_READ_FAILED',api.error())
    return buffer
  }
  function add(files) {
    if(released)fail('WINDOW_FILE_PROTECTION_STALE')
    if(!Array.isArray(files)||!files.length||files.length>MAX_FILES_PER_ADD)fail('WINDOW_FILE_PROTECTION_BUDGET')
    for(const input of files) {
      if(typeof input!=='string'||!isAbsolute(input)||!/^[a-z]:[\\/]/i.test(input))fail('WINDOW_FILE_PROTECTION_PATH_DENIED')
      const path=resolve(input),root=parse(path).root
      if(!volumes.has(root)) {
        const format=Buffer.alloc(512)
        if(!api.volume(root,null,0,null,null,null,format,256)||format.toString('utf16le').split('\0')[0]!=='NTFS')fail('WINDOW_FILE_PROTECTION_VOLUME_UNSUPPORTED')
        volumes.add(root)
      }
      for(const ancestor of ancestors(path))open(ancestor,true)
      const exists=entries.has(normalized(path)),entry=open(path,false)
      if(!exists)totalBytes+=entry.size
      if(totalBytes>MAX_TOTAL_BYTES)fail('WINDOW_FILE_PROTECTION_BUDGET')
      const digest=sha(readFile(path)),cold=/\.cold-([a-f0-9]{64})\.json$/.exec(path)
      if(cold&&cold[1]!==digest)fail('WINDOW_FILE_PROTECTION_COLD_INTEGRITY')
      entry.sha256=digest
    }
  }
  function assertHeld() {
    if(released)fail('WINDOW_FILE_PROTECTION_STALE')
    for(const entry of entries.values())if(describe(entry.handle,entry.path,entry.directory).identity!==entry.identity)fail('WINDOW_FILE_PROTECTION_IDENTITY_CHANGED')
    return true
  }
  function release() {
    if(released)fail('WINDOW_FILE_PROTECTION_STALE')
    released=true;let failed=false
    for(const entry of [...entries.values()].reverse())if(!api.close(entry.handle))failed=true
    entries.clear()
    if(failed)fail('WINDOW_FILE_PROTECTION_RELEASE_FAILED')
  }
  try {add(paths);assertHeld()}catch(error){try{release()}catch{}throw error}
  return Object.freeze({add,readFile,assertHeld,release,
    get receipt(){return Object.freeze({kind:'windows-share-deny-write-delete-v1',pid:process.pid,
      files:[...entries.values()].filter(entry=>!entry.directory).map(({path,identity,sha256})=>({path,identity,sha256})),
      namespace:[...entries.values()].filter(entry=>entry.directory).map(({path,identity})=>({path,identity}))})}})
}

// The loaded-code certificate reads this module's own source hash from here (see team-v15-window-loaded.mjs).
import { registerLoadedModule } from './team-v15-window-loaded.mjs'
registerLoadedModule(import.meta.url)
