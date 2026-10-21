import { redactString } from './redact.js';

/** Bounded choices from the user's request; JeV selects, never generates. */
export function taskSummaryCandidates(goal) {
  if(typeof goal!=='string')return [];
  const text=redactString(goal).replace(/\r\n?/g,'\n').trim();
  const sentences=text.split(/(?<=[。！？!?])\s*|[；;\n]+/u);
  const clauses=sentences.flatMap(sentence=>sentence.split(/[，,:：]/u));
  const seen=new Set(),candidates=[];
  for(const raw of [...sentences,...clauses]) {
    const value=raw.replace(/^(?:请(?:你|帮我)?|麻烦(?:你|帮我)?|我想(?:要)?|I (?:want|need) you to|Please)\s*/iu,'')
      .replace(/\s+/g,' ').replace(/[。.!！?？]+$/u,'').trim();
    if(value.length<4||value.length>120||seen.has(value))continue;
    seen.add(value);candidates.push({id:`goal${candidates.length+1}`,text:value});
    if(candidates.length===8)break;
  }
  return candidates;
}
