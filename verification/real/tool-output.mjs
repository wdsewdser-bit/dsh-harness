export function assertLosslessJson(value){
  const seen=new Set();
  const bad=path=>{const e=Error('TOOL_OUTPUT_ERROR: INVALID_TOOL_OUTPUT: value is not lossless JSON at '+path);e.name='ToolOutputError';e.code
    ='INVALID_TOOL_OUTPUT';e.path=path;throw e};
  function visit(v,path){
    if(v===null||typeof v==='string'||typeof v==='boolean')return;
    if(typeof v==='number'){if(!Number.isFinite(v)||Object.is(v,-0))bad(path);return;}
    if(typeof v!=='object'||seen.has(v))bad(path);
    if(!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype)bad(path);
    seen.add(v);
    if(Array.isArray(v)){
      if(Reflect.ownKeys(v).length!==v.length+1)bad(path);
      for(let i=0;i<v.length;i++){const d=Object.getOwnPropertyDescriptor(v,String(i));if(!d||!('value'in d))bad(path+'['+i+']');visit(d.value,path+'['+i+']');}
    }else for(const key of Reflect.ownKeys(v)){
      const d=Object.getOwnPropertyDescriptor(v,key);if(typeof key!=='string'||!d.enumerable||!('value'in d))bad(path);
      visit(d.value,path+'.'+key);
    }
    seen.delete(v);
  }
  visit(value,'$');return value;
}
export function nativeToolErrors(session,messages=null){
  const journal=session.snapshotEvents(),visible=messages?new Set(messages.map(m=>m.id)):null;
  return journal.filter(e=>e.type==='tool/result'&&e.data.message?.isError&&(!visible||visible.has(e.data.message.id))).map(e=>{
    const m=e.data.message,call=journal.find(c=>c.type==='tool/call'&&c.data.callId===m.toolCallId);
    return{source:'native-journal',nativeSessionId:session.id,nativeSeq:e.seq,nativeMessageId:m.id,sourceEventSeqs:e.sourceEventSeqs??[],callId:m.toolCallId,
      name:call?.data.name??null,code:e.data.error?.code??'TOOL_ERROR',errorName:e.data.error?.name??null,message:m.content.filter(b=>b.type==='text').map(b=>
      b.text)
      .join(' ')};
  });
}
// Upstream renders a plain Error as "Error: CODE: ..." in the native journal; preserve other exception names.
export const nativeErrorCode=e=>e.code&&e.code!=='TOOL_ERROR'?e.code:String(e.message??'').replace(/^Error:\s*/,'').split(':')[0];
export const isOutputError=e=>e.code==='INVALID_TOOL_OUTPUT'||e.errorName==='ToolOutputError'||/INVALID_TOOL_OUTPUT|not lossless JSON|returned invalid output/
.test(e.message??'');
