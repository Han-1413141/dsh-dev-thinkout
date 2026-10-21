import test from 'node:test';
import assert from 'node:assert/strict';
import {createNarrator} from '../src/narrator.js';
import {compactGraph} from '../web/canvas.js';

test('native summaries have disabled thinking and an isolated, bounded request',async()=>{
  let sent;
  const llm={prepareCall:async config=>({config,stream:async function*(options){
    sent=options;
    yield {type:'text-delta',text:'{"status":"Planning the animation","summary":"The scene will use a synchronized cycling motion."}'};
    yield {type:'finish',reason:{kind:'stop'}};
  }})};
  const result=await createNarrator(llm)({text:'Plan the animation. '+ 'x'.repeat(10000),
    taskGoal:'SVG animation',intent:'planned',kind:'plan'},new AbortController().signal);
  assert.equal(result.status,'Planning the animation');
  assert.equal(sent.reasoningEffort,'off');
  assert.equal(sent.maxTokens,320);
  assert.equal(sent.messages.length,1);
  assert.equal(JSON.parse(sent.messages[0].content[0].text).observation.length,3000);
  assert.equal('sessionId' in sent,false);
  assert.equal('tools' in sent,false);
  assert.match(sent.system,/never say the proposed execution has started/);
});

test('flow preserves distinct features, isolates turns and layers serial/parallel work',()=>{
  const graph={nodes:[{id:'old',turn:1},{id:'a',turn:2,text:'方案'},{id:'b',turn:2,text:'动画'},{id:'c',turn:2,text:'交互'},{id:'d',turn:2,text:'验收'}],relations:[
    {from:'a',to:'b',type:'next'},{from:'a',to:'c',type:'next'},{from:'b',to:'c',type:'parallel'},
    {from:'b',to:'d',type:'next'},{from:'c',to:'d',type:'next'}]};
  const layout=compactGraph(graph,2,960);
  assert.equal(layout.nodes.length,4);
  assert.equal(layout.parallelGroups.length,1);
  assert.equal(layout.positions.get('b').y,layout.positions.get('c').y);
  assert.ok(layout.positions.get('a').y<layout.positions.get('b').y);
  assert.ok(layout.positions.get('b').y<layout.positions.get('d').y);
  assert.equal(layout.edges.length,4);
  assert.ok(layout.width<=910);
  assert.ok(layout.nodes.every(node=>node.turn===2));
});
