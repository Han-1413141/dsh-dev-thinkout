import { buildQuestions, splitCandidateSentences, JEV_MODEL } from './core/questions.js';
import { parseDecision } from './core/decision.js';
import { redactString } from './core/redact.js';

export const CANDIDATE_GATE = Object.freeze({
  type:'noul',
  instructions:'Does this work note give the user a concrete update on what the assistant is doing, will do next, has found, has finished, or is blocked by?',
  criteria:{
    true:'A specific action with an object: inspecting files, editing a module, writing tests or documentation, choosing an approach. Or a concrete finding, result, or unresolved obstacle. Planned actions count.',
    false:'Code or example data, vague reactions or headings, repeated filler, speculative edge cases, or implementation details without a specific work action or finding.',
  },
});
const invalid=()=>Object.assign(Error('invalid_decision'),{code:'invalid_decision'});

/** Rank complete sentences first, so a paragraph-level score cannot hide a
 * useful action or label a different sentence. All returned text stays local. */
export async function classifyCandidates(client,contexts,signal) {
  if(!contexts.length)return {items:[],apiCalls:0};
  if(contexts.length>4)throw RangeError('Maximum four paragraphs');
  let apiCalls=0;
  const send=async requests=>{
    const payload={model:JEV_MODEL,state:requests[0].state,questions:requests[0].questions};
    if(requests.length>1)payload.states=Object.fromEntries(requests.slice(1).map((r,i)=>[`p${i+1}`,{state:r.state,questions:r.questions}]));
    const {data}=await client.decide(payload,signal);apiCalls++;
    return requests.map((r,i)=>i===0?data:{...data.states?.[`p${i}`],model:data.model});
  };
  const rows=contexts.map(context=>splitCandidateSentences(redactString(context.text||context.segment||'')));
  const paragraphRequests=contexts.map(buildQuestions);
  const gates=rows.flatMap((row,index)=>[
    ...row.map(text=>({index,text,state:text,questions:{worth:CANDIDATE_GATE}})),
    ...(row.length>1?[{index,paragraph:true,state:paragraphRequests[index].state,
      questions:{worth:paragraphRequests[index].questions.worth,
        sentence:paragraphRequests[index].questions.sentence}}]:[])
  ]);
  if(!gates.length)return {items:contexts.map(()=>({decision:{ok:true,shouldDisplay:false}})),apiCalls};
  const answers=await send(gates);
  const best=contexts.map(()=>null);
  answers.forEach((data,i)=>{
    const probability=data.answers?.worth?.noul;
    if(data.model!==JEV_MODEL || data.answers?.worth?.type!=='noul' || !Number.isFinite(probability) || probability<0 || probability>1)throw invalid();
    const row=gates[i];
    let text=row.text;
    if(row.paragraph) {
      const candidate=paragraphRequests[row.index].meta.candidates.find(c=>c.id===data.answers?.sentence?.choice);
      if(!candidate)throw invalid();
      text=candidate.text;
    }
    if(!best[row.index] || probability>best[row.index].probability)best[row.index]={text,probability};
  });
  const items=contexts.map(()=>({decision:{ok:true,shouldDisplay:false}}));
  const selected=best.flatMap((candidate,index)=>candidate && candidate.probability>=.5 ? [{index,candidate}] : []);
  if(selected.length) {
    const requests=selected.map(({index,candidate})=>buildQuestions({...contexts[index],text:candidate.text,
      segment:undefined,currentText:undefined,lines:undefined,focus:true}));
    const refined=await send(requests);
    selected.forEach(({index,candidate},n)=>{
      // The gate comes from the selected sentence's own independent question.
      // Keep the response parser's strict enum and probability validation.
      const response={...refined[n],answers:{...refined[n].answers,worth:{type:'noul',noul:candidate.probability}}};
      const decision=parseDecision(response,requests[n]);
      items[index]=decision.ok?{decision}:{error:invalid()};
    });
  }
  return {items,apiCalls};
}
