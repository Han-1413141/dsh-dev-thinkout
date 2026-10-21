const flowKey=value=>String(value??'').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
const flowOrder=(a,b)=>(Number(a.turn)||0)-(Number(b.turn)||0)||(Number(a.step)||0)-(Number(b.step)||0)||(a.sourceOffset??0)-(b.sourceOffset??0)||(a.sourceAt??a.firstAt??a.at??0)-(b.sourceAt??b.firstAt??b.at??0);
const flowPhases={understand:'理解需求',research:'资料与环境',plan:'制定方案',implement:'制作与实现',verify:'检查与验证',debug:'排查与修正',deliver:'整理与交付',other:'工作进展'};
const flowStatus=items=>items.some(i=>i.status==='blocked')?'blocked':items.some(i=>i.status==='active')?'active':items.some(i=>i.status==='planned')?'planned':items.length&&items.every(i=>i.status==='completed')?'completed':items.length&&items.every(i=>['completed','reported_done'].includes(i.status))?'reported_done':'planned';

/** Task -> work item -> public history. Missing ownership remains a separate stage. */
export function taskFlow(source,tasks=[]) {
  const groups=new Map(),leaves=new Map(),membership=new Map(),known=new Map(tasks.map(t=>[t.id,t]));
  const ensure=(id,title,task)=>{
    if(!groups.has(id))groups.set(id,{id,title,task,kind:task?'task':'stage',status:task?.status||'planned',children:[],records:[]});
    return groups.get(id);
  };
  for(const node of source.nodes.slice().sort(flowOrder)){
    const task=known.get(node.taskId),phase=node.phase||'other';
    const parent=node.taskId?'task:'+node.taskId:'stage:'+phase;
    const group=ensure(parent,task?.title||node.taskTitle||flowPhases[phase]||flowPhases.other,task||null);
    if(node.taskId)group.kind='task';
    const work=node.workItem?.trim(),id=parent+'/'+(work?'work:'+flowKey(work):'activity:'+phase+':'+(node.activity||phase));
    let leaf=leaves.get(id);
    if(!leaf){leaf={id,parentId:parent,title:work||flowPhases[phase]||flowPhases.other,phase,status:node.intent||'planned',records:[]};leaves.set(id,leaf);group.children.push(leaf);}
    leaf.status=node.intent||'planned';leaf.records.push(node);group.records.push(node);membership.set(node.id,id);
  }
  // Host checklist items are still visible before their first progress record.
  for(const task of tasks)ensure('task:'+task.id,task.title||'任务',task);
  for(const group of groups.values())if(!group.task)group.status=flowStatus(group.children);
  const edges=[],groupEdges=[],seen=new Set(),groupSeen=new Map();
  for(const edge of source.edges){
    const from=membership.get(edge.from),to=membership.get(edge.to);if(!from||!to||from===to||edge.type==='unrelated')continue;
    const key=[from,to,edge.type].join('|');if(!seen.has(key)){seen.add(key);edges.push({...edge,from,to});}
    const a=leaves.get(from).parentId,b=leaves.get(to).parentId,gkey=[a,b,edge.type].join('|');
    if(a!==b){
      const link={from,to,fromTitle:leaves.get(from).title,toTitle:leaves.get(to).title};
      if(!groupSeen.has(gkey)){const promoted={...edge,from:a,to:b,scope:'work-item',links:[link]};groupSeen.set(gkey,promoted);groupEdges.push(promoted);}
      else if(!groupSeen.get(gkey).links.some(e=>e.from===from&&e.to===to))groupSeen.get(gkey).links.push(link);
    }
  }
  const result=[...groups.values()];
  for(const group of result){const ids=new Set(group.children.map(child=>child.id));group.edges=edges.filter(edge=>ids.has(edge.from)&&ids.has(edge.to));}
  return {groups:result,edges:groupEdges,leaves:[...leaves.values()],recordCount:source.nodes.length};
}

/** Evidence-based horizontal layers. Disconnected items never become parallel by position. */
export function arrangeFlow(items,relations=[]) {
  const ids=new Set(items.map(i=>i.id)),index=new Map(items.map((item,i)=>[item.id,i]));
  const edges=relations.filter(e=>ids.has(e.from)&&ids.has(e.to)&&e.from!==e.to&&e.type!=='unrelated');
  const parent=new Map(items.map(i=>[i.id,i.id])),next=new Map(items.map(i=>[i.id,[]])),accepted=[],uncertain=[];
  const root=id=>{let p=id;while(parent.get(p)!==p)p=parent.get(p);return p;};
  const reaches=(from,to)=>{const queue=[from],seen=new Set();for(let i=0;i<queue.length;i++){const id=queue[i];if(id===to)return true;if(seen.has(id))continue;seen.add(id);queue.push(...(next.get(id)||[]));}return false;};
  for(const edge of edges.filter(e=>['next','continue'].includes(e.type))){
    if(reaches(edge.to,edge.from)){uncertain.push({...edge,type:'unconfirmed'});continue;}
    next.get(edge.from).push(edge.to);accepted.push(edge);
  }
  for(const edge of edges.filter(e=>e.type==='parallel')){
    const from=root(edge.from),to=root(edge.to),contracted=new Map();
    for(const serial of accepted.filter(e=>e.type!=='parallel')){const a=root(serial.from),b=root(serial.to);if(a===b)continue;if(!contracted.has(a))contracted.set(a,[]);contracted.get(a).push(b);}
    const connected=(a,b)=>{const queue=[a],seen=new Set();for(let i=0;i<queue.length;i++){const id=queue[i];if(id===b)return true;if(seen.has(id))continue;seen.add(id);queue.push(...(contracted.get(id)||[]));}return false;};
    if(from!==to&&(connected(from,to)||connected(to,from)))uncertain.push({...edge,type:'unconfirmed'});
    else{parent.set(root(edge.to),root(edge.from));accepted.push(edge);}
  }
  const components=new Map();for(const item of items){const id=root(item.id);if(!components.has(id))components.set(id,[]);components.get(id).push(item);}
  const arcs=new Map([...components.keys()].map(id=>[id,new Set()])),incoming=new Map([...components.keys()].map(id=>[id,0]));
  for(const e of accepted.filter(e=>e.type!=='parallel')){const a=root(e.from),b=root(e.to);if(a!==b&&!arcs.get(a).has(b)){arcs.get(a).add(b);incoming.set(b,incoming.get(b)+1);}}
  const rank=new Map([...components.keys()].map(id=>[id,0])),queue=[...components.keys()].filter(id=>!incoming.get(id));
  const visited=new Set();for(let i=0;i<queue.length;i++){const id=queue[i];visited.add(id);for(const child of arcs.get(id)){rank.set(child,Math.max(rank.get(child),rank.get(id)+1));incoming.set(child,incoming.get(child)-1);if(!incoming.get(child))queue.push(child);}}
  // Contracting parallel nodes can expose an inconsistent path. Keep the view bounded.
  for(const id of components.keys())if(!visited.has(id))rank.set(id,0);
  const adjacency=new Map([...components.keys()].map(id=>[id,new Set()]));
  for(const [from,list]of arcs)for(const to of list){adjacency.get(from).add(to);adjacency.get(to).add(from);}
  const seen=new Set(),bands=[];
  for(const start of components.keys()){
    if(seen.has(start))continue;const pending=[start],members=[];
    for(let i=0;i<pending.length;i++){const id=pending[i];if(seen.has(id))continue;seen.add(id);members.push(id);pending.push(...adjacency.get(id));}
    const ranks=[...new Set(members.map(id=>rank.get(id)))].sort((a,b)=>a-b);
    const columns=ranks.map(r=>members.filter(id=>rank.get(id)===r).sort((a,b)=>index.get(components.get(a)[0].id)-index.get(components.get(b)[0].id)).map(id=>({id,items:components.get(id),parallel:components.get(id).length>1})));
    bands.push({id:members[0],columns,itemIds:members.flatMap(id=>components.get(id).map(item=>item.id)),connected:members.length>1||components.get(start).length>1});
  }
  // Unconnected records share a collection row, explicitly without dependency arrows.
  const independent=bands.filter(b=>!b.connected),connected=bands.filter(b=>b.connected);
  if(independent.length)connected.push({id:'independent',independent:true,columns:independent.map(b=>b.columns[0]),itemIds:independent.flatMap(b=>b.itemIds)});
  return {bands:connected,edges:[...accepted,...edges.filter(e=>['revise','unconfirmed'].includes(e.type)),...uncertain],parallelGroups:[...components].filter(([,v])=>v.length>1).map(([id,v])=>({id,itemIds:v.map(i=>i.id)}))};
}

/** Exact repeated sentences are shown once; the source history stays intact. */
export function flowHistory(records){
  const unique=new Map();for(const record of records.slice().sort(flowOrder)){const text=record.summary||record.text||'',key=flowKey(text);if(key)unique.set(key,record);}
  return [...unique.values()].sort(flowOrder);
}
