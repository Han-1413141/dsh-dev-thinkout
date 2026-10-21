import { buildQuestions, buildFocusQuestions } from './core/questions.js';
import { parseDecision } from './core/decision.js';

const publicRequest = request => ({ state:request.state, questions:request.questions });

/** The API batches independent states; each retains its own fixed questions. */
export async function classifyBatch(client, contexts, signal) {
  if (!contexts.length) return { items:[], apiCalls:0 };
  if (contexts.length > 4) throw new RangeError('Progress batch maximum is four paragraphs');
  let apiCalls = 0;
  const send = async requests => {
    const payload = { model:requests[0].model, ...publicRequest(requests[0]) };
    if (requests.length > 1) payload.states = Object.fromEntries(requests.slice(1).map((request,i)=>[`p${i+1}`,publicRequest(request)]));
    const { data } = await client.decide(payload,signal);
    apiCalls++;
    return requests.map((request,i) => {
      const body = i===0 ? data : { ...data.states?.[`p${i}`], model:data.model };
      const decision = parseDecision(body,request);
      return decision.ok ? {decision} : {error:Object.assign(Error('invalid_decision'),{code:'invalid_decision'})};
    });
  };
  const requests = contexts.map(buildQuestions);
  const items = await send(requests);
  const focus = [];
  for (let i=0;i<items.length;i++) {
    if (items[i].decision?.sentence && JSON.parse(requests[i].state).excerpt.trim().replace(/\s+/g,' ') !== items[i].decision.sentence.text.trim()) {
      // Keep the selected sentence as the target and add only its immediate
      // neighbors for references and following corrections. The second pass
      // stays batched with the other focus requests.
      focus.push({index:i,request:buildFocusQuestions(contexts[i],items[i].decision.sentence.text)});
    }
  }
  if (focus.length) {
    const refined = await send(focus.map(item=>item.request));
    focus.forEach((item,i)=>{items[item.index]=refined[i];});
  }
  return {items,apiCalls};
}
