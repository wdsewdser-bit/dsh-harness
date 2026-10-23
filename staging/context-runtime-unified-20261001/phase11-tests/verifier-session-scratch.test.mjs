import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../home/profiles/web/plugins/write-scope-guard.mjs'

const roots=[]
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})})
function git(root,...args) {
  const result=spawnSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true})
  assert.equal(result.status,0,result.stderr)
  return result.stdout
}
function harness({group='verifier',scopes={},mode='session-workspace',ignored=true}={}) {
  const root=mkdtempSync(join(tmpdir(),'dsh-session-scratch-')); roots.push(root)
  git(root,'init','-b','main')
  if(ignored)writeFileSync(join(root,'.git','info','exclude'),'\n.dsh-verifier-scratch/\n')
  const hooks=new Map(),tools=new Map(),row={id:'native-v1',name:'v1',groupId:group}
  const agent={id:'native-v1',session:{id:'native-v1',header:{cwd:root}},ctx:{tools:{register:tool=>{tools.set(tool.name,tool);return ()=>tools.delete(tool.name)}}}}
  const membership={id:'team-a',name:'v1',role:'teammate'}
  const service={tryMembership:current=>current===agent?membership:undefined,listMembers:current=>{assert.equal(current,agent);return [row]}}
  const scopesFile=join(root,'scopes.json')
  writeFileSync(scopesFile,JSON.stringify({rootDir:root,defaultDeny:true,byName:scopes}))
  const ctx={agentTeams:service,agents:{list:()=>[agent]},on:(event,callback)=>{hooks.set(event,callback);return ()=>{}},logger:{warn:()=>{}}}
  const binding={worktreePath:undefined,enabled:false}
  const controlPlane={leaseList:()=>binding.enabled?[{member:'v1',taskId:'task-v1',status:'active'}]:[],
    planState:()=>({state:'plan-approved',writeScopes:['.']}),
    boardSnapshot:()=>({board:{tasks:{task:{id:'task-v1',worktreePath:binding.worktreePath}}}})}
  apply(ctx,{scopesFile,enforce:true,verifierScratchMode:mode,controlDir:root,controlPlane})
  const own=join(realpathSync.native(root),'.dsh-verifier-scratch',agent.session.id)
  const intent=(path,key=path,event='fs/write-intent')=>hooks.get(event)({displayPath:path,targetKey:key},{agent})
  const locate=()=>tools.get('verifier_scratch').execute({}, {agent})
  const shell=command=>hooks.get('tools/pre-execute')({tool:{name:'pwsh'},arguments:{command},agent},async()=>({kind:'allow'}))
  return {root,own,agent,row,service,hooks,tools,intent,locate,binding,shell}
}
const denied=error=>error?.code==='FS_WRITE_OUT_OF_SCOPE'

test('moving or renaming a product source into owned scratch requires source permission',async()=>{
  const h=harness(),product=join(h.root,'product.txt'),destination=join(h.own,'moved.txt')
  writeFileSync(product,'unchanged product')
  for(const command of [`Move-Item -LiteralPath '${product}' -Destination '${destination}'`,
    `Move-Item '${product}' '${destination}'`,
    `Rename-Item -LiteralPath '${product}' -NewName '${destination}'`]) {
    await assert.rejects(()=>h.shell(command),denied)
  }
  assert.equal(readFileSync(product,'utf8'),'unchanged product')
  assert.equal((await h.shell(`Copy-Item -LiteralPath '${product}' -Destination '${destination}'`)).kind,'allow')
  assert.equal((await h.shell(`Move-Item '${join(h.own,'old.txt')}' '${destination}'`)).kind,'allow')
})

test('session scratch shell refuses creation of hard links, junctions and symbolic links',async()=>{
  const h=harness(),product=join(h.root,'product.txt'),alias=join(h.own,'alias')
  writeFileSync(product,'unchanged product')
  for(const type of ['HardLink','Junction','SymbolicLink']) {
    await assert.rejects(()=>h.shell(`New-Item -ItemType ${type} -Path '${alias}' -Value '${product}'; Set-Content '${alias}' changed`),denied)
    await assert.rejects(()=>h.shell(`New-Item -Type ${type} -Path '${alias}' -Value '${product}'`),denied)
  }
  await assert.rejects(()=>h.shell(`New-Item -ItemT HardLink -Path '${alias}' -Value '${product}'`),denied)
  await assert.rejects(()=>h.shell(`ni -ItemType HardLink -Path '${alias}' -Value '${product}'`),denied)
  assert.equal((await h.shell(`New-Item -ItemType Directory -Path '${join(h.own,'safe')}'`)).kind,'allow')
})

test('existing hardlinked scratch leaves are refused on native write/edit and shell writes',async()=>{
  const h=harness(),product=join(h.root,'product.txt'),alias=join(h.own,'alias.txt')
  mkdirSync(h.own,{recursive:true});writeFileSync(product,'unchanged product');linkSync(product,alias)
  assert.throws(()=>h.intent(alias),denied)
  assert.throws(()=>h.intent(alias,alias,'fs/edit-intent'),denied)
  await assert.rejects(()=>h.shell(`Set-Content '${alias}' changed`),denied)
  assert.equal(readFileSync(product,'utf8'),'unchanged product')
})

test('Git mutation from scratch honors binding even when native membership omits tier',async()=>{
  const h=harness(),other=harness()
  mkdirSync(h.own,{recursive:true});h.binding.enabled=true;h.binding.worktreePath=other.root
  await assert.rejects(()=>h.shell(`git -C '${h.own}' commit -am probe`),denied)
  h.binding.worktreePath=h.root
  assert.equal((await h.shell(`git -C '${h.own}' commit -am probe`)).kind,'allow')
  await assert.rejects(()=>h.shell(`git -C '${h.own}' -c core.worktree='${other.root}' commit -am probe`),denied)
  h.binding.worktreePath=h.own
  await assert.rejects(()=>h.shell(`git -C '${h.own}' commit -am probe`),denied)
  h.binding.worktreePath=undefined
  await assert.rejects(()=>h.shell(`git -C '${h.own}' add -A`),denied)
})

test('every Git write segment and nested script carrier is checked against the bound checkout',async()=>{
  const h=harness(),other=harness()
  h.binding.enabled=true;h.binding.worktreePath=h.root
  const bad=`git -C '${h.root}' add -A; git -C '${other.root}' commit -am probe`
  await assert.rejects(()=>h.shell(bad),denied)
  const script=join(h.root,'probe.ps1');writeFileSync(script,`git -C '${other.root}' commit -am probe`)
  await assert.rejects(()=>h.shell(`pwsh -File '${script}'`),denied)
})

test('positional Rename-Item checks the resolved new name as well as the source',async()=>{
  const h=harness()
  await assert.rejects(()=>h.shell(`Rename-Item '${join(h.own,'old.txt')}' -NewName '${join(h.root,'product.txt')}'`),denied)
  assert.equal((await h.shell(`Rename-Item '${join(h.own,'old.txt')}' 'new.txt'`)).kind,'allow')
})

test('an approved script cannot override a session-mode link-creation refusal',async()=>{
  const h=harness(),script=join(h.root,'probe.ps1')
  h.binding.enabled=true;h.binding.worktreePath=h.root
  writeFileSync(script,`New-Item -ItemT HardLink -Path '${join(h.own,'alias')}' -Value '${join(h.root,'product.txt')}'`)
  await assert.rejects(()=>h.shell(`pwsh -File '${script}'`),denied)
})

test('directory-changing shell composition cannot switch Git writes away from the lease repository',async()=>{
  const h=harness(),nested=join(h.root,'nested-repository')
  mkdirSync(h.own,{recursive:true});mkdirSync(nested);git(nested,'init','-b','main')
  h.binding.enabled=true;h.binding.worktreePath=h.root
  for(const change of ['cd','Set-Location','Push-Location','sl','chdir',"& 'Set-Location'","& 'cd'"]) {
    await assert.rejects(()=>h.shell(`${change} '${nested}'; git commit -am probe`),denied)
  }
  const script=join(h.root,'probe.ps1');writeFileSync(script,`cd '${nested}'; git commit -am probe`)
  await assert.rejects(()=>h.shell(`pwsh -File '${script}'`),denied)
})

test('session scratch locator is read-only and own native write/edit/shell targets are allowed',async()=>{
  const h=harness(),path=join(h.own,'probe.txt')
  const receipt=await h.locate()
  assert.equal(receipt.ok,true);assert.equal(receipt.root,h.own);assert.equal(receipt.ownerSessionId,h.agent.session.id)
  assert.equal(existsSync(h.own),false)
  h.intent(path);h.intent(path,path,'fs/edit-intent')
  const allowed=await h.hooks.get('tools/pre-execute')({tool:{name:'pwsh'},arguments:{command:`Set-Content '${path}' x`},agent:h.agent},async()=>({kind:'allow'}))
  assert.equal(allowed.kind,'allow')
  for(const bad of [join(h.root,'product.txt'),join(h.root,'verifier-scratch','old.txt'),h.own+'-evil/probe.txt',join(h.root,'.dsh-verifier-scratch','other-session','probe.txt')]) {
    assert.throws(()=>h.intent(bad),denied)
    await assert.rejects(()=>h.hooks.get('tools/pre-execute')({tool:{name:'pwsh'},arguments:{command:`Set-Content '${bad}' x`},agent:h.agent},async()=>({kind:'allow'})),denied)
  }
})

test('reserved scratch cannot fall through to a broad ordinary static scope',async()=>{
  const h=harness({group:'alpha',scopes:{v1:['.dsh-verifier-scratch']}})
  assert.equal((await h.locate()).ok,false)
  assert.throws(()=>h.intent(join(h.own,'probe.txt')),denied)
})

test('scratch ownership is revalidated after group or roster identity changes',async()=>{
  for(const change of [row=>{row.groupId='alpha'},row=>{row.id='foreign-id'},row=>{row.name='other-name'}]) {
    const h=harness();assert.equal((await h.locate()).ok,true);change(h.row)
    assert.equal((await h.locate()).ok,false)
    assert.throws(()=>h.intent(join(h.own,'probe.txt')),denied)
  }
  const h=harness();h.service.listMembers=()=>{throw new Error('unavailable')}
  assert.equal((await h.locate()).ok,false)
  assert.throws(()=>h.intent(join(h.own,'probe.txt')),denied)
})

test('locator refuses missing or unsafe session/workspace identity and foreign execute actor',async()=>{
  for(const mutate of [h=>{h.agent.session.id='../other'},h=>{h.agent.session.header.cwd='relative'},h=>{delete h.agent.session.header.cwd},h=>{h.agent.session.id=''}]) {
    const h=harness();mutate(h);assert.equal((await h.locate()).ok,false)
    assert.throws(()=>h.intent(join(h.own,'probe.txt')),denied)
  }
  const h=harness()
  assert.equal((await h.tools.get('verifier_scratch').execute({}, {agent:{...h.agent}})).ok,false)
})

test('nested junction cannot redirect controlled writes or shell targets into product files',async()=>{
  const h=harness(),product=join(h.root,'product')
  mkdirSync(h.own,{recursive:true});mkdirSync(product)
  const link=join(h.own,'link');symlinkSync(product,link,'junction')
  const display=join(link,'new.txt'),physical=join(realpathSync.native(product),'new.txt')
  assert.throws(()=>h.intent(display,physical),denied)
  assert.throws(()=>h.intent(display),denied)
  await assert.rejects(()=>h.hooks.get('tools/pre-execute')({tool:{name:'pwsh'},arguments:{command:`Set-Content '${display}' x`},agent:h.agent},async()=>({kind:'allow'})),denied)
})

test('namespace junction cannot turn the scratch locator into a product directory',async()=>{
  const h=harness(),product=join(h.root,'product');mkdirSync(product)
  symlinkSync(product,join(h.root,'.dsh-verifier-scratch'),'junction')
  assert.equal((await h.locate()).ok,false)
  assert.throws(()=>h.intent(join(h.own,'new.txt')),denied)
})

test('same session label in separate Team workspaces never grants cross-workspace scratch access',async()=>{
  const a=harness(),b=harness()
  assert.notEqual((await a.locate()).root,(await b.locate()).root)
  a.intent(join(a.own,'own.txt'))
  assert.throws(()=>a.intent(join(b.own,'foreign.txt')),denied)
})

test('operator wildcard override is preserved, not mistaken for verifier-only access',async()=>{
  const h=harness({group:'alpha',scopes:{v1:'*'}})
  assert.equal((await h.locate()).ok,false)
  h.intent(join(h.own,'operator.txt'))
})

test('new mode is opt-in and tool registrations follow agent disposal',()=>{
  const legacy=harness({mode:'legacy'})
  assert.equal(legacy.tools.has('verifier_scratch'),false)
  assert.throws(()=>legacy.intent(join(legacy.own,'probe.txt')),denied)
  const h=harness();assert.equal(h.tools.has('verifier_scratch'),true)
  h.hooks.get('agent/disposed')({agent:h.agent})
  assert.equal(h.tools.has('verifier_scratch'),false)
})

test('Git workspace refuses scratch until an existing ignore rule isolates its namespace',async()=>{
  const h=harness({ignored:false})
  assert.equal((await h.locate()).ok,false)
  assert.throws(()=>h.intent(join(h.own,'probe.txt')),denied)
  writeFileSync(join(h.root,'.git','info','exclude'),'\n.dsh-verifier-scratch/\n')
  assert.equal((await h.locate()).ok,true)
  h.intent(join(h.own,'probe.txt'))
})

test('tracked scratch entries are rejected even with an ignore rule',async()=>{
  const h=harness()
  mkdirSync(h.own,{recursive:true});writeFileSync(join(h.own,'tracked.txt'),'tracked artifact')
  git(h.root,'add','--force','--','.dsh-verifier-scratch')
  assert.equal((await h.locate()).ok,false)
  assert.throws(()=>h.intent(join(h.own,'new.txt')),denied)
})

test('ignore removal is observed on the next locator and mutation without stale approval',async()=>{
  const h=harness();assert.equal((await h.locate()).ok,true)
  writeFileSync(join(h.root,'.git','info','exclude'),'')
  assert.equal((await h.locate()).ok,false)
  assert.throws(()=>h.intent(join(h.own,'new.txt')),denied)
})

test('ordinary git add -A stages product fixtures but excludes scratch artifacts',async()=>{
  const h=harness();assert.equal((await h.locate()).ok,true)
  mkdirSync(h.own,{recursive:true});writeFileSync(join(h.own,'probe.txt'),'verification artifact')
  writeFileSync(join(h.root,'product.txt'),'product fixture')
  const ignoreBefore=readFileSync(join(h.root,'.git','info','exclude'))
  await h.locate()
  assert.deepEqual(readFileSync(join(h.root,'.git','info','exclude')),ignoreBefore)
  git(h.root,'add','-A')
  const indexed=git(h.root,'ls-files','-z').split('\0').filter(Boolean)
  assert.equal(indexed.includes('product.txt'),true)
  assert.equal(indexed.some(file=>file.startsWith('.dsh-verifier-scratch/')),false)
})

test('scratch already in HEAD stays refused even after it is removed from the index',async()=>{
  const h=harness()
  mkdirSync(h.own,{recursive:true});writeFileSync(join(h.own,'tracked.txt'),'tracked artifact')
  git(h.root,'add','--force','--','.dsh-verifier-scratch')
  git(h.root,'-c','user.name=fixture','-c','user.email=fixture@local','commit','-m','tracked scratch fixture')
  git(h.root,'rm','--cached','-r','--','.dsh-verifier-scratch')
  assert.equal((await h.locate()).ok,false)
  assert.throws(()=>h.intent(join(h.own,'new.txt')),denied)
})

test('corrupt Git metadata fails closed rather than being treated as a non-Git workspace',async()=>{
  const h=harness()
  writeFileSync(join(h.root,'.git','HEAD'),'invalid header\n')
  assert.equal((await h.locate()).ok,false)
  assert.throws(()=>h.intent(join(h.own,'new.txt')),denied)
})

test('a normal committed repository permits ignored scratch without tracked entries',async()=>{
  const h=harness()
  writeFileSync(join(h.root,'product.txt'),'product fixture')
  git(h.root,'add','--','product.txt')
  git(h.root,'-c','user.name=fixture','-c','user.email=fixture@local','commit','-m','product baseline')
  assert.equal((await h.locate()).ok,true)
  h.intent(join(h.own,'probe.txt'))
})

test('linked worktree Git files and inherited common excludes preserve the owned boundary',async()=>{
  const h=harness()
  writeFileSync(join(h.root,'product.txt'),'product fixture')
  git(h.root,'add','--','product.txt')
  git(h.root,'-c','user.name=fixture','-c','user.email=fixture@local','commit','-m','product baseline')
  const worktree=join(h.root,'linked-worktree')
  git(h.root,'worktree','add','--detach',worktree,'HEAD')
  h.agent.session.header.cwd=worktree
  const own=join(realpathSync.native(worktree),'.dsh-verifier-scratch',h.agent.session.id)
  assert.equal((await h.locate()).root,own)
  h.intent(join(own,'probe.txt'))
  assert.throws(()=>h.intent(join(h.own,'old-workspace.txt')),denied)
})

test('foreign inherited Git environment cannot redirect the read-only isolation check',async()=>{
  const h=harness(),foreign=harness({ignored:false})
  const previousDir=process.env.GIT_DIR,previousTree=process.env.GIT_WORK_TREE
  try {
    process.env.GIT_DIR=join(foreign.root,'.git');process.env.GIT_WORK_TREE=foreign.root
    assert.equal((await h.locate()).ok,true)
    h.intent(join(h.own,'probe.txt'))
  } finally {
    if(previousDir===undefined)delete process.env.GIT_DIR;else process.env.GIT_DIR=previousDir
    if(previousTree===undefined)delete process.env.GIT_WORK_TREE;else process.env.GIT_WORK_TREE=previousTree
  }
})

test('unavailable Git executable fails closed for a Git workspace',async()=>{
  const h=harness(),previousPath=process.env.PATH
  try {
    process.env.PATH=h.root
    assert.equal((await h.locate()).ok,false)
    assert.throws(()=>h.intent(join(h.own,'new.txt')),denied)
  } finally {
    if(previousPath===undefined)delete process.env.PATH;else process.env.PATH=previousPath
  }
})

test('Windows namespace case aliases do not bypass case-sensitive Git ignores',{skip:process.platform!=='win32'},async()=>{
  const h=harness()
  git(h.root,'config','core.ignorecase','false')
  mkdirSync(join(h.root,'.DSH-VERIFIER-SCRATCH'))
  assert.equal((await h.locate()).ok,false)
  assert.throws(()=>h.intent(join(h.own,'new.txt')),denied)
})

test('configured global excludes are shared by the permission check and ordinary Git staging',async()=>{
  const h=harness({ignored:false}),previous=process.env.GIT_CONFIG_GLOBAL
  const globalConfig=join(h.root,'git-global.cfg'),globalExclude=join(h.root,'git-global.exclude')
  writeFileSync(globalExclude,'.dsh-verifier-scratch/\n')
  writeFileSync(globalConfig,'[core]\nexcludesFile = '+JSON.stringify(globalExclude.replaceAll('\\','/'))+'\n')
  try {
    process.env.GIT_CONFIG_GLOBAL=globalConfig
    assert.equal((await h.locate()).ok,true)
    h.intent(join(h.own,'probe.txt'))
    mkdirSync(h.own,{recursive:true});writeFileSync(join(h.own,'probe.txt'),'artifact')
    git(h.root,'add','-A')
    assert.equal(git(h.root,'ls-files','--','.dsh-verifier-scratch/'),'')
  } finally {
    if(previous===undefined)delete process.env.GIT_CONFIG_GLOBAL;else process.env.GIT_CONFIG_GLOBAL=previous
  }
})
