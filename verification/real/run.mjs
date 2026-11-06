import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import {stages
  } from './config.mjs';import {scopedRoot} from './scope.mjs';
const [stage,...args]=process.argv.slice(2),dry=args.includes('--dry-run'),fake=args.includes('--fake-provider');const allowed=new Set(['--root',
    '--authorize-provider','--dry-run','--fake-provider','--fake-fault','--arm']);let root,fault='',arm='off';for(let n=0;n<args.length;n++){if(!allowed
    .has(args[n]))throw Error('UNKNOWN_OPTION');if(args[n]==='--root')root=args[++n];else if(args[n]==='--fake-fault')fault=args[++n];else if(args[
    n]==='--arm')arm
  =args[++n]}
// The A/B switch of the collaboration experiment: only the collab stage has two arms, and only 'off' and 'on' exist.
if(!['off','on'].includes(arm))throw Error('INVALID_ARM');if(arm==='on'&&stage!=='collab')throw Error('ARM_ONLY_FOR_COLLAB_STAGE');
const base=path.resolve(fileURLToPath(new URL('../../',import.meta.url)));if(!stages[stage]||!root||!path
  .isAbsolute(root))throw Error('USE_STAGE_AND_ABSOLUTE_EMPTY_ROOT');root=scopedRoot(root);if(!root.toLowerCase().startsWith(base.toLowerCase()+path.sep)||fs
  .existsSync(root)&&fs.readdirSync(root).length)throw Error('ROOT_MUST_BE_EMPTY_INSIDE_DSH_V2');if(dry&&fake||fault&&!fake||fault&&!['reject-reasoning',
    'omit-accept','invalid-tool-output','review-before-open','repeat-tool-call','turn-request-limit','truncate-output'].includes(fault))
  throw Error('INVALID_MODE');
if(!dry&&!fake
  &&(!args.includes('--authorize-provider')||!process.env.CLOSEOUT_PROVIDER_KEY))throw Error('EXPLICIT_AUTHORIZATION_AND_ENV_KEY_REQUIRED');
const env={};for(const k of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','COMSPEC','PATHEXT','DSH_UPSTREAM_BUILD','DSH_BUDGET_LEDGER',
    'DSH_PERF_FAKE_SMALL','COLLAB_WATCH_TOKEN','COLLAB_WATCH_PORT','COLLAB_WATCH_VIEWER_PORT','COLLAB_WATCH_VIEWER'])if(process.env[k])env[k]=process.env[k];
    if(!dry
  &&!fake)env.CLOSEOUT_PROVIDER_KEY=process.env.CLOSEOUT_PROVIDER_KEY;env.DSH_HOME=root;const mode=dry?'dry':fake?'fake':'live';const child=spawn(process
  .execPath,[fileURLToPath(new URL('worker.mjs',import.meta.url)),stage,root,mode,args.includes('--authorize-provider')?'authorized':'unauthorized',fault,arm],{
    cwd:base,env,stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});child.stdout.resume();child.stderr.resume();child.on('error',()=>{console
    .error('REAL_WORKER_START_FAILED');process.exitCode=1});for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>{if(child.connected)child.send({stop:true})});
    child
.on('exit',code=>{console.log(JSON.stringify({stage,mode,arm,exitCode:code,report:path.join(root,'report.json')}));process.exitCode=code??1});
