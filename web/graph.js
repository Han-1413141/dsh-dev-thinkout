const graphText=value=>String(value??'').toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
const graphOrder=(a,b)=>(Number(a.turn)-Number(b.turn))||((Number(a.step)||0)-(Number(b.step)||0))||((a.sourceOffset??0)-(b.sourceOffset??0))||((a.sourceAt??a.firstAt??0)-(b.sourceAt??b.firstAt??0));
const graphTitle=node=>String(node.workItem||node.taskTitle||node.text||'工作进展').replace(/^(?:正在|已报告完成[：:]|规划[：:]|计划)+/g,'').replace(/^正在/,'').trim();

/** Build a view graph without losing distinct functions under one activity. */
export function taskGraph(graph,turn,messages=[],branch='all') {
  const original=(graph?.nodes??[]).filter(n=>!n.cancelled&&(turn==null||String(n.turn)===String(turn)));
  const notes=messages.filter(m=>!m.cancelled&&['plan_summary','stage_summary'].includes(m.kind)&&(turn==null||String(m.turn)===String(turn))).sort(graphOrder);
  const byId=new Map(original.map(n=>[n.id,n])),nodes=[],aliases=new Map(),summaryNodes=new Map();
  for(const note of notes) {
    const source=byId.get(note.nodeId)??(Number.isFinite(note.step)?original.find(n=>n.step===note.step&&n.phase===note.phase):null)??original.find(n=>n.phase===note.phase&&Number.isFinite(note.sourceAt)&&note.sourceAt>=n.firstAt&&note.sourceAt<=n.lastAt);
    const key=note.workItem?`feature:${note.goalSeq}:${note.taskId??source?.taskId??''}:${graphText(note.workItem)}:${note.phase}`:`summary:${note.goalSeq}:${graphText(note.text)}`;
    const prior=summaryNodes.get(key);
    const node={...source,...note,id:key,text:note.workItem||note.text.split(/[。；\n]/)[0],summary:note.text,
      taskId:note.taskId??source?.taskId??null,taskTitle:source?.taskTitle??null,workItem:note.workItem||'',
      relation:note.relation, intent:note.intent??(note.kind==='plan_summary'?'planned':'active'),firstAt:note.sourceAt??note.at,lastAt:note.at,
      branchKey:note.workItem?graphText(note.workItem):note.taskId??source?.taskId??null};
    if(prior)Object.assign(prior,node);else {summaryNodes.set(key,node);nodes.push(node);}
    if(source){const list=aliases.get(source.id)??[];if(!list.includes(key))list.push(key);aliases.set(source.id,list);}
  }
  for(const node of original)if(!aliases.has(node.id)){nodes.push({...node,text:graphTitle(node),branchKey:node.workItem?graphText(node.workItem):node.taskId});aliases.set(node.id,[node.id]);}
  const edges=[],seen=new Set();
  const add=(from,to,type,inferred=true)=>{if(!from||!to||from===to||type==='unrelated')return;const key=`${from}:${to}:${type}`;if(!seen.has(key)){seen.add(key);edges.push({from,to,type,inferred});}};
  for(const edge of graph?.relations??[]) {
    const a=aliases.get(edge.from),b=aliases.get(edge.to);
    if(a&&b)add(a.at(-1),b[0],edge.type,edge.inferred);
  }
  const ordered=nodes.slice().sort(graphOrder),sourceIndex=new Map();ordered.forEach((node,i)=>sourceIndex.set(node.id,i));
  for(let i=1;i<ordered.length;i++) {
    const node=ordered[i],previous=ordered[i-1];
    if(node.previousNodeId||node.relation){const from=aliases.get(node.previousNodeId)?.filter(id=>(sourceIndex.get(id)??Infinity)<i).at(-1)??previous.id;add(from,node.id,node.relation??'next');}
  }
  const retained=nodes.filter(n=>branch==='all'||n.branchKey===branch||n.taskId===branch).slice(-120);
  const ids=new Set(retained.map(n=>n.id));
  return {nodes:retained,edges:edges.filter(e=>ids.has(e.from)&&ids.has(e.to)),branches:[...new Map(nodes.filter(n=>n.branchKey).map(n=>[n.branchKey,{id:n.branchKey,title:n.workItem||n.taskTitle||graphTitle(n)}])).values()]};
}

/** Dependency layers advance downward; parallel components share a layer. */
export function layoutTaskGraph(source) {
  const nodes=source.nodes,ids=new Set(nodes.map(n=>n.id)),parent=new Map(nodes.map(n=>[n.id,n.id]));
  source={...source,edges:source.edges.filter(e=>ids.has(e.from)&&ids.has(e.to)&&e.from!==e.to)};
  const root=id=>{let p=id;while(parent.get(p)!==p)p=parent.get(p);let q=id;while(parent.get(q)!==q){const next=parent.get(q);parent.set(q,p);q=next;}return p;};
  const serial=source.edges.filter(e=>e.type!=='parallel'&&e.type!=='revise');
  const next=new Map(nodes.map(n=>[n.id,[]]));serial.forEach(e=>next.get(e.from)?.push(e.to));
  const reaches=(from,to)=>{const queue=[from],visited=new Set();for(let i=0;i<queue.length;i++){const id=queue[i];if(id===to)return true;if(visited.has(id))continue;visited.add(id);queue.push(...(next.get(id)??[]));}return false;};
  for(const e of source.edges)if(e.type==='parallel'){
    const a=nodes.filter(n=>root(n.id)===root(e.from)),b=nodes.filter(n=>root(n.id)===root(e.to));
    if(!a.some(x=>b.some(y=>reaches(x.id,y.id)||reaches(y.id,x.id))))parent.set(root(e.to),root(e.from));
  }
  const components=new Map();for(const n of nodes){const id=root(n.id),items=components.get(id)??[];items.push(n);components.set(id,items);}
  const arcs=new Map([...components].map(([id])=>[id,new Set()])),incoming=new Map([...components].map(([id])=>[id,0]));
  for(const e of serial){const a=root(e.from),b=root(e.to);if(a!==b&&!arcs.get(a).has(b)){arcs.get(a).add(b);incoming.set(b,incoming.get(b)+1);}}
  const rank=new Map([...components].map(([id])=>[id,0])),queue=[...components.keys()].filter(id=>incoming.get(id)===0),visited=new Set();
  for(let i=0;i<queue.length;i++){const id=queue[i];visited.add(id);for(const child of arcs.get(id)){rank.set(child,Math.max(rank.get(child),rank.get(id)+1));incoming.set(child,incoming.get(child)-1);if(!incoming.get(child))queue.push(child);}}
  // A contradictory inferred cycle does not send cards to remote coordinates.
  for(const id of components.keys())if(!visited.has(id))rank.set(id,Math.max(0,...rank.values())+1);
  const layers=new Map();for(const [id,items] of components){const r=rank.get(id),groups=layers.get(r)??[];groups.push({id,items});layers.set(r,groups);}
  const maxColumns=Math.min(3,Math.max(1,...[...layers.values()].map(groups=>groups.reduce((n,g)=>n+g.items.length,0))));
  const width=maxColumns*298-48+64,positions=new Map(),parallelGroups=[];let y=32;
  for(const [,groups] of [...layers].sort((a,b)=>a[0]-b[0])){
    let pending=[];
    const place=(items,parallelId)=>{
      const bounds=[];
      for(let i=0;i<items.length;i++){
        const row=Math.floor(i/3),column=i%3,columns=Math.min(3,items.length-row*3);
        const position={x:(width-(columns*298-48))/2+column*298,y:y+28+row*192};
        positions.set(items[i].id,position);bounds.push(position);
      }
      if(parallelId){
        const left=Math.min(...bounds.map(p=>p.x)),top=Math.min(...bounds.map(p=>p.y));
        parallelGroups.push({id:parallelId,x:left-12,y:top-28,width:Math.max(...bounds.map(p=>p.x))+262-left,
          height:Math.max(...bounds.map(p=>p.y))+158-top+28,nodeIds:items.map(n=>n.id)});
      }
      y+=Math.ceil(items.length/3)*192+64;
    };
    for(const group of groups){
      if(group.items.length>1){if(pending.length){place(pending);pending=[];}place(group.items,group.id);}
      else pending.push(group.items[0]);
    }
    if(pending.length)place(pending);
  }
  const edges=source.edges.filter(e=>e.type!=='parallel'||root(e.from)!==root(e.to)).map(e=>({...e,
    type:e.type==='parallel'?'unconfirmed':e.type,
    cycle:rank.get(root(e.to))<=rank.get(root(e.from))}));
  return {...source,edges,positions,parallelGroups,width,height:Math.max(180,y-28)};
}

/** A readable overview: one card per task/stage, with the full history on demand. */
export function taskOverview(source,tasks=[]) {
 const titles={understand:'需求与范围',research:'资料与环境',plan:'方案与规划',implement:'实现与制作',verify:'检查与验证',debug:'问题与修正',deliver:'整理与交付',other:'其他进展'};
 const groups=new Map(),membership=new Map(),known=new Map(tasks.map(t=>[t.id,t]));
 for(const node of source.nodes.slice().sort(graphOrder)){
  const task=known.get(node.taskId),key=task?'task:'+task.id:'stage:'+(node.phase||'other');
  const group=groups.get(key)??{id:key,title:task?.title||titles[node.phase]||titles.other,task,status:task?.status||node.intent,nodes:[],features:[]};
  group.nodes.push(node);membership.set(node.id,key);if(!task)group.status=node.intent;
  const feature=node.workItem||graphTitle(node);if(feature&&!group.features.some(f=>graphText(f)===graphText(feature)))group.features.push(feature);
  groups.set(key,group);
 }
 const edges=[],seen=new Set();
 for(const edge of source.edges){const from=membership.get(edge.from),to=membership.get(edge.to),key=[from,to,edge.type].join(':');if(from&&to&&from!==to&&!seen.has(key)){seen.add(key);edges.push({...edge,from,to});}}
 for(const group of groups.values())group.parallelCount=source.edges.filter(e=>e.type==='parallel'&&membership.get(e.from)===group.id&&membership.get(e.to)===group.id).length;
 return {groups:[...groups.values()],edges,nodeCount:source.nodes.length};
}
