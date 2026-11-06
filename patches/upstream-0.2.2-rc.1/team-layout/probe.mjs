import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
import { C2, PRISTINE } from '../paths.mjs';
const roots={original:PRISTINE,patched:C2+'/node_modules/@deepseek-ai/'};
const component=(base,pkg,name)=>{const s=fs.readFileSync(base+pkg+'/lib/client.js','utf8'),start=s.indexOf('function '+name+'('),end=s.indexOf('//#endregion',start);assert(start>=0&&end>start);return s.slice(start,end).trim();};
const jsx=(type,props)=>({type,props});
// rc.1 renders the sidebar as an overlay below the frame's drawer breakpoint and calls useModalLayer for that state;
// the stub keeps the tree decision under test (which seats render) independent of the host's modal plumbing.
const primitives=new Proxy({isDarwinDesktop:()=>false,useModalLayer:()=>{}},{get:(o,k)=>k in o?o[k]:String(k)});
const css=new Proxy({},{get:(_,k)=>String(k)});
const reactStub=new Proxy({useState:v=>[v,()=>{}],useRef:v=>({current:v}),useEffect:()=>{},useLayoutEffect:()=>{},useMemo:f=>f(),useCallback:f=>f},{get:(o,k)=>k in o?o[k]:()=>{}});
const globals={react:reactStub,react_jsx_runtime:{jsx,jsxs:jsx},
 _deepseek_ai_dsh_client_ui_primitives:primitives,SidebarRoot_module_css_default:css,clsx:(...xs)=>xs.filter(Boolean).join(' '),
 document:{documentElement:{hasAttribute:()=>false}},localBuildVersion:()=>undefined,PanelList:'PanelList',SCROLLBAR_LINGER_MS:100,COLLAPSE_SETTLE_MS:100};
const load=(base,pkg,name)=>vm.runInNewContext('('+component(base,pkg,name)+')',globals);
const clean=v=>JSON.parse(JSON.stringify(v,(_,x)=>typeof x==='function'?'[callback]':x));
for(const collapsed of [false,true])for(const width of [240,320])for(const drawer of [false,true]){
 const calls=[];const renderSlot=(key,props)=>{const node={slot:key,props};calls.push(node);return node;};
 const props={collapsed,width,drawer,startSession:()=>{},toggleSidebar:()=>{},selectPanel:()=>{},setPinned:()=>{},trackEntryClick:()=>{},
  useRemoteAccess:()=>true,usePanels:f=>f([]),useEntryPins:f=>f([]),useEntryActions:f=>f(false),useBodyWrapper:f=>f(false),useShortcuts:f=>f([]),usePanelInfo:f=>f({activePanelId:null}),t:x=>x,renderSlot};
 const native=load(roots.original,'dsh-client-ui-sidebar','SidebarRoot')(props);
 const render=load(roots.patched,'dsh-client-ui-sidebar','SidebarRoot');
 assert.deepEqual(clean(render(props)),clean(native),'unregistered sidebar must produce identical element tree');
 const before=calls.length,wrapped=render({...props,useBodyWrapper:f=>f(true)}),wrapper=calls.slice(before).find(c=>c.slot==='sidebar.body.wrapper');
 assert(wrapper);assert.equal(wrapper.props.children.slot,'sidebar.workspaces');assert.equal(wrapper.props.collapsed,collapsed);
 // rc.1 computes `wide = drawer || (windowsTitlebar ? !collapsed : !collapsed || !settled)`; the wrapper must receive
 // exactly what the workspaces seat receives, and drawer mode is always wide.
 const inner=calls.filter(c=>c.slot==='sidebar.workspaces').at(-1);
 assert.equal(wrapper.props.wide,inner.props.wide,'the wrapper must receive the wide the workspaces seat receives');
 assert.equal(wrapper.props.wide,drawer?true:!collapsed,'rc.1: wide is true in drawer mode');
 assert.deepEqual(clean(render(props)),clean(native),'unregister must immediately restore native element tree');
}
console.log('PASS sidebar: exact native element-tree parity in 8 states (collapsed x width x drawer); registered children/width/collapsed; unregister restores');
{
 const nativeChild={native:true},calls=[];const renderSlot=(key,props)=>{calls.push({key,props});return key==='main.conversation'?nativeChild:{wrapper:true,props};};
 const original=load(roots.original,'dsh-client-ui-conversation','ConversationPanel'),patched=load(roots.patched,'dsh-client-ui-conversation','ConversationPanel');
 assert.equal(original({renderSlot}),nativeChild);assert.equal(patched({renderSlot,useFrame:f=>f(false)}),nativeChild);
 const framed=patched({renderSlot,useFrame:f=>f(true)});assert.equal(framed.props.children,nativeChild);assert.equal(calls.at(-1).key,'main.conversation.frame');
 assert.equal(patched({renderSlot,useFrame:f=>f(false)}),nativeChild);
 console.log('PASS conversation frame: absent returns same native object; present gets original children; unregister restores');
}
// Execute the actual authored snapshot hooks, not a parallel reimplementation.
for(const [pkg,key,extract]of [['dsh-client-ui-sidebar','sidebar.body.wrapper',s=>s.match(/const bodyWrapper = (.*);/)[1]],['dsh-client-ui-conversation','main.conversation.frame',s=>s.match(/hooks: \{ frame: (\{ getSnapshot: .*? \}) \} \}/)[1]]]){
 const s=fs.readFileSync(roots.patched+pkg+'/lib/client.js','utf8');let registered=false,listener,removed=0;
 const slots={entriesOfSlot:k=>{assert.equal(k,key);return registered?[{}]:[];},subscribe:(k,f)=>{assert.equal(k,key);listener=f;return()=>{removed++;listener=undefined;};}};
 const hook=vm.runInNewContext('('+extract(s)+')',{ctx:{slots},slots});
 assert.equal(hook.getSnapshot(),false);let changed=0;const off=hook.subscribe(()=>changed++);registered=true;listener();assert.equal(hook.getSnapshot(),true);registered=false;listener();assert.equal(hook.getSnapshot(),false);assert.equal(changed,2);off();assert.equal(removed,1);
}
console.log('PASS layout snapshot subscriptions: add/remove notify; disposer detaches; seats have exact declared scope');
