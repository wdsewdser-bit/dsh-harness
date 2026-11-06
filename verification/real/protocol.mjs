import {createHash} from 'node:crypto';
const NL=String.fromCharCode(10);
export const digest=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
export function wire(messages,raw){const input=[];for(const m of messages){if(m.role==='tool'){input.push({type:'function_call_output',call_id:m.toolCallId??m
          .source?.callId,output:m.content.map(b=>b.text??'').join(NL)});continue}if(m.role==='assistant'&&raw[m.id]){input.push(...structuredClone(raw[m.id]));
          continue
      }for(const b of m.content??[]){if(b.type==='reasoning')throw Error('OPAQUE_REASONING_MAPPING_MISSING:'+m.id+':'+Object.keys(raw).length);if(b
        .type==='tool-call')input.push({type:'function_call',call_id:b.id,name:b.name,arguments:b.arguments});else if(b.type==='text')input.push({role:m.role,
            content:[{
              type:m.role==='assistant'?'output_text':'input_text',text:b.text}]})}}checkPairs(input);return input
  }
export function checkPairs(input){const calls=new Set(),results=new Set();for(const x of input){if(x.type==='function_call'){if(calls.has(x
          .call_id))throw Error('DUPLICATE_TOOL_CALL');calls.add(x.call_id)}if(x.type==='function_call_output'){if(!calls.has(x.call_id)||results.has(x
          .call_id))throw Error('ORPHAN_TOOL_RESULT');results.add(x.call_id)}}if(calls.size!==results.size)throw Error('UNPAIRED_TOOL_CALL');return true
  }
/**
 * Did the provider stop this response at its output cap?
 *
 * A Responses-API result carries `status:"incomplete"` and `incomplete_details.reason:"max_output_tokens"` when the
 * model was cut off mid-step; the output that survived is a fragment (the first real collaboration run's members were
 * cut in the middle of a large write and the truncated turn was counted as a normal end). The finish reason is the only
 * channel the agent loop reads, so the adapter has to translate it: everything below and upstream already understands
 * `max-tokens` (dsh-llm's FinishReasonMap, the block assembler's tool-call pruning, dsh-agent-loop's step result), and
 * none of them can see a truncation the adapter reports as `stop`.
 */
export function truncation(result){const reason=result?.incomplete_details?.reason??null;
  return {status:result?.status??null,reason,truncated:result?.status==='incomplete'&&reason==='max_output_tokens'}}
export function* chunks(result){let index=0,tools=false;for(const x of result.output??[]){let block;if(x.type==='reasoning')block={type:'reasoning',text:(x
        .summary??[]).map(x=>x.text??'').join(NL)};if(x.type==='function_call'){tools=true;block={type:'tool-call',id:x.call_id,name:x.name,arguments:
          x.arguments}}if(
        x
      .type==='message')block={type:'text',text:(x.content??[]).filter(b=>b.type==='output_text').map(b=>b.text).join(NL)};if(block){yield{type:'block-start',
        index,
        blockType:block.type};yield{type:'block-end',index:index++,block}}}yield{type:'usage',usage:{inputTokens:result.usage.input_tokens,outputTokens:
        result.usage
      .output_tokens,totalTokens:result.usage.input_tokens+result.usage.output_tokens,cacheReadTokens:result.usage.input_tokens_details?.cached_tokens}};
  // A truncated step is never "completed": max-tokens wins over the tool calls it dropped.
  yield{type:'finish',reason:{kind:truncation(result).truncated?'max-tokens':tools?'tool-calls':'stop'}}}
/** Keep only completed raw items that actually survived an interrupted native assistant message. */
export function interruptedRaw(output,content){
  let cursor=0;const kept=[];
  for(const block of content??[]){
    const matches=item=>block.type==='reasoning'&&item.type==='reasoning'&&(item.summary??[]).map(x=>x.text??'').join(NL)===(block.text??'') ||
      block.type==='text'&&item.type==='message'&&(item.content??[]).filter(x=>x.type==='output_text').map(x=>x.text).join(NL)===(block.text??'') ||
      block.type==='tool-call'&&item.type==='function_call'&&item.call_id===block.id&&item.name===block.name&&item.arguments===block.arguments;
    const index=output.findIndex((item,i)=>i>=cursor&&matches(item));
    if(index<0)throw Error('OPAQUE_REASONING_MAPPING_MISSING:interrupted-block');
    kept.push(structuredClone(output[index]));cursor=index+1;
  }
  return kept;
}
