import {taskFlow,arrangeFlow,flowHistory} from './flow-model.js';
import {uiIcon} from './icons.js';

let flowInstance=0;
/** Native scrolling and frame-batched connectors; no redraw while panning. */
export function mountTaskFlow(holder,{phase,status,onMetrics=()=>{}}={}){
  const doc=holder.ownerDocument,win=doc.defaultView,ns='http://www.w3.org/2000/svg',instance='jev-flow-'+(++flowInstance);
  const el=(tag,cls,value)=>{const node=doc.createElement(tag);node.className=cls;if(value!=null)node.textContent=value;return node;};
  const root=el('section','jev-horizontal-flow'),viewport=el('div','jev-flow-viewport'),surface=el('div','jev-flow-surface');
  const project=el('section','jev-flow-project'),head=el('div','jev-flow-project-head'),projectTitle=el('h3','jev-flow-project-title'),projectCount=el('span','jev-flow-project-count'),body=el('div','jev-flow-body');
  head.append(projectTitle,projectCount);project.append(head,body);surface.append(project);viewport.append(surface);root.append(viewport);holder.replaceChildren(root);
  const shade=el('button','jev-flow-shade'),drawer=el('section','jev-flow-drawer'),drawerHead=el('div','jev-flow-drawer-head'),drawerTitle=el('h3','','任务详情'),close=el('button','jev-flow-detail-close'),detail=el('div','jev-flow-detail-content');
  close.innerHTML=uiIcon('close');
  shade.type='button';shade.setAttribute('aria-label','收起任务详情');shade.tabIndex=-1;close.type='button';close.setAttribute('aria-label','关闭任务详情');
  drawerTitle.id=instance+'-detail';drawer.setAttribute('role','dialog');drawer.setAttribute('aria-labelledby',drawerTitle.id);drawer.inert=true;drawer.setAttribute('aria-hidden','true');drawerHead.append(drawerTitle,close);drawer.append(drawerHead,detail);root.append(shade,drawer);
  let model,arrangement,revision='',selected=null,lastFocus=null,scale=1,frame=0,panFrame=0,drag=null,disposed=false,direction='horizontal',input,gridSequence=0;
  root.dataset.direction=direction;
  const collapsed=new Set(),parents=new Map(),cards=new Map(),grids=[];
  function closeDetail(){if(!selected)return false;selected=null;root.classList.remove('has-detail');drawer.inert=true;drawer.setAttribute('aria-hidden','true');lastFocus?.focus();return true;}
  close.onclick=closeDetail;shade.onclick=closeDetail;
  function showDetail(item,trigger){
    selected=item.id;lastFocus=trigger||lastFocus;root.classList.add('has-detail');drawer.inert=false;drawer.setAttribute('aria-hidden','false');
    const parent=model.groups.find(g=>g.id===item.parentId),records=flowHistory(item.records||[]);
    detail.replaceChildren(el('p','jev-flow-breadcrumb',parent?parent.title+' / '+item.title:item.kind==='stage'?'按阶段归组 · '+item.title:'父任务 / '+item.title),el('h3','jev-flow-detail-title',item.title),el('p','jev-flow-detail-meta',(status[item.status]||'进展记录')+' · '+records.length+' 条进展'));
    if(item.children?.length){const children=el('div','jev-flow-detail-children');for(const child of item.children){const button=el('button','',child.title+' · '+(status[child.status]||'进展记录'));button.type='button';button.onclick=()=>showDetail(child,trigger);children.append(button);}detail.append(children);}
    if(!item.parentId){const links=model.edges.filter(e=>e.from===item.id||e.to===item.id);if(links.length){const relations=el('div','jev-flow-detail-relations');for(const edge of links)for(const link of edge.links||[]){const row=el('p','jev-flow-relation'),kind=el('span','jev-flow-relation-kind');kind.innerHTML=uiIcon(edge.type==='parallel'?'parallel':edge.type==='revise'?'revise':'next');kind.append(doc.createTextNode(edge.type==='parallel'?'并行':edge.type==='revise'?'修订':'串行'));row.append(el('span','',link.fromTitle),kind,el('span','',link.toTitle));relations.append(row);}detail.append(relations);}}
    const list=el('ol','jev-flow-timeline');
    for(const record of records){const row=el('li',''),time=el('span','jev-flow-event-meta',(phase[record.phase]||'工作进展')+' · '+(status[record.intent]||'进展记录'));row.append(time,el('p','',record.summary||record.text));list.append(row);}
    if(!records.length)detail.append(el('p','jev-flow-no-history','这项任务还没有新的进展记录。'));else detail.append(list);
    close.focus();
  }
  root.addEventListener('keydown',event=>{if(event.key==='Escape'&&selected){event.preventDefault();event.stopPropagation();closeDetail();}else if(event.key==='Tab'&&selected){const buttons=[...drawer.querySelectorAll('button')],first=buttons[0],last=buttons.at(-1);if(event.shiftKey&&doc.activeElement===first){last.focus();event.preventDefault();}else if(!event.shiftKey&&doc.activeElement===last){first.focus();event.preventDefault();}}});
  function leafCard(item){
    let entry=cards.get(item.id);
    if(!entry){const card=el('button','jev-flow-task'),state=el('span','jev-flow-task-state'),title=el('strong','jev-flow-task-title'),count=el('span','jev-flow-task-count');card.type='button';card.append(state,title,count);entry={card,state,title,count};cards.set(item.id,entry);card.onclick=()=>showDetail(entry.item,card);}
    entry.item=item;entry.card.dataset.status=item.status;entry.card.dataset.item=item.id;entry.card.title=item.title;
    const stateLabel=status[item.status]||'进展记录',stateKey=item.status+':'+stateLabel;
    if(entry.stateKey!==stateKey){entry.state.innerHTML=uiIcon(item.status==='active'?'dot':['completed','reported_done'].includes(item.status)?'check':'circle');entry.state.append(doc.createTextNode(stateLabel));entry.stateKey=stateKey;}
    entry.title.textContent=item.title;const visibleCount=flowHistory(item.records).length;
    if(entry.visibleCount!==visibleCount){entry.count.textContent=visibleCount+' 条进展 ';entry.count.insertAdjacentHTML('beforeend',uiIcon('external'));entry.visibleCount=visibleCount;}
    return entry.card;
  }
  function groupCard(group,compact){
    let entry=parents.get(group.id);
    if(!entry){
      const card=el('section','jev-flow-parent'),heading=el('button','jev-flow-parent-heading'),label=el('span','jev-flow-parent-label'),title=el('strong'),state=el('span','jev-flow-parent-state'),chevron=el('span','jev-flow-parent-chevron'),content=el('div','jev-flow-parent-content'),summary=el('button','jev-flow-collapsed-summary');
      chevron.innerHTML=uiIcon('chevron');
      heading.type='button';summary.type='button';label.append(title,el('small','jev-flow-parent-kind'));heading.append(label,state,chevron);card.append(heading,content,summary);content.id=instance+'-group-'+parents.size;heading.setAttribute('aria-controls',content.id);
      entry={card,heading,label,title,state,content,summary};parents.set(group.id,entry);
      if(group.children.length>8)collapsed.add(group.id);
      heading.onclick=()=>{collapsed.has(group.id)?collapsed.delete(group.id):collapsed.add(group.id);applyCollapse(entry);schedule();};summary.onclick=()=>showDetail(entry.group,summary);
    }
    entry.group=group;entry.title.textContent=group.title;entry.title.title=group.title;entry.label.querySelector('small').textContent=group.kind==='task'?'父任务':'阶段分组';entry.state.textContent=status[group.status]||'进展记录';entry.card.dataset.status=group.status;
    entry.summary.textContent=group.children.length+' 项工作 · '+flowHistory(group.records).length+' 条进展，点击查看';
    entry.content.replaceChildren();
    const local=arrangeFlow(group.children,group.edges);appendBands(entry.content,local,item=>leafCard(item),false,compact,190);
    if(!group.children.length)entry.content.append(el('p','jev-flow-no-history','暂无关联的进展记录'));
    applyCollapse(entry);return entry.card;
  }
  function applyCollapse(entry){const isClosed=collapsed.has(entry.group.id);entry.heading.setAttribute('aria-expanded',String(!isClosed));entry.card.classList.toggle('is-collapsed',isClosed);entry.content.hidden=isClosed;entry.summary.hidden=!isClosed;}
  function minimum(group){if(group.children.length<=2)return 235;const layout=arrangeFlow(group.children,group.edges),ranks=Math.max(1,...layout.bands.filter(b=>!b.independent).map(b=>b.columns.length));return Math.min(720,Math.max(390,ranks*190+(ranks-1)*32+28));}
  function appendBands(target,plan,render,isRoot=false,vertical=false,min=190){
    for(const band of plan.bands){
      const wrapper=el('section','jev-flow-band');
      if(band.independent&&band.itemIds.length>1)wrapper.append(el('p','jev-flow-independent-label',isRoot?'其他任务与阶段 · 关系未记录':'其他工作项 · 关系未记录'));
      const grid=el('div','jev-flow-grid');grid.classList.toggle('is-independent',!!band.independent);grid.classList.toggle('is-vertical',vertical&&!band.independent);grid.style.setProperty('--flow-columns',band.columns.length);
      const minWidths=band.columns.map(column=>Math.max(min,...column.flatMap(component=>component.items.map(item=>isRoot?minimum(item):min))));
      if(!band.independent&&!vertical){grid.style.gridTemplateColumns=minWidths.map(size=>`minmax(${size}px,${Math.max(1,size/min).toFixed(2)}fr)`).join(' ');}
      const svg=doc.createElementNS(ns,'svg');svg.classList.add('jev-flow-lines');svg.setAttribute('aria-hidden','true');grid.dataset.marker=String(++gridSequence);grid.append(svg);
      const rendered=new Map(),parallel=[];
      for(const column of band.columns){const col=el('div','jev-flow-column');for(const component of column){const box=el('div',component.parallel?'jev-flow-parallel':'jev-flow-items');if(component.parallel){box.style.setProperty('--flow-parallel-count',component.items.length);const label=el('span','jev-flow-parallel-label');label.innerHTML=uiIcon('parallel');label.append(doc.createTextNode('并行 · '+component.items.length+' 个分支'));box.append(label);parallel.push(box);}for(const item of component.items){const card=render(item);box.append(card);rendered.set(item.id,card);}col.append(box);}grid.append(col);}
      const set=new Set(band.itemIds);grids.push({grid,svg,rendered,parallel,edges:plan.edges.filter(e=>set.has(e.from)&&set.has(e.to)),vertical:vertical&&!band.independent});wrapper.append(grid);target.append(wrapper);
    }
  }
  function update(source,tasks,goal){
    input={source,tasks,goal};
    model=taskFlow(source,tasks);arrangement=arrangeFlow(model.groups,model.edges);
    const next=JSON.stringify([model,goal,direction]);if(next===revision)return;revision=next;
    const left=viewport.scrollLeft,top=viewport.scrollTop,focused=doc.activeElement;grids.length=0;body.replaceChildren();
    projectTitle.textContent=goal||'当前任务';projectTitle.title=goal||'当前任务';
    projectCount.textContent=model.groups.filter(g=>['reported_done','completed'].includes(g.status)).length+' / '+model.groups.length+' 组已报告完成 · '+model.recordCount+' 条记录';
    appendBands(body,arrangement,group=>groupCard(group,direction==='horizontal'&&group.children.length<=2&&arrangement.bands.some(b=>b.columns.length>1&&!b.independent)),true,false,235);
    project.style.minWidth=(direction==='vertical'?Math.max(620,...arrangement.bands.flatMap(b=>b.columns.flatMap(column=>column.map(component=>component.parallel?component.items.length*235+component.items.length*15+48:0)))):Math.max(0,...arrangement.bands.filter(b=>!b.independent).map(b=>b.columns.reduce((n,column)=>n+Math.max(235,...column.flatMap(component=>component.items.map(minimum))),0)+(b.columns.length-1)*44+48)))+'px';
    if(!model.groups.length)body.append(el('p','jev-flow-empty','开始任务后，新的工作进展会出现在这里。'));
    const groupIds=new Set(model.groups.map(g=>g.id)),leafIds=new Set(model.leaves.map(l=>l.id));
    for(const id of parents.keys())if(!groupIds.has(id)){parents.delete(id);collapsed.delete(id);}for(const id of cards.keys())if(!leafIds.has(id))cards.delete(id);
    if(selected){const item=model.groups.find(g=>g.id===selected)||model.leaves.find(l=>l.id===selected);if(item){const focus=doc.activeElement;showDetail(item);if(drawer.contains(focus))focus.focus();}else closeDetail();}
    viewport.scrollLeft=left;viewport.scrollTop=top;if(focused?.isConnected&&root.contains(focused))focused.focus({preventScroll:true});
    onMetrics({groups:model.groups.length,leaves:model.leaves.length,records:model.recordCount,parallel:arrangement.parallelGroups.length+model.groups.reduce((n,g)=>n+arrangeFlow(g.children,g.edges).parallelGroups.length,0),relations:arrangement.edges.length+model.groups.reduce((n,g)=>n+g.edges.length,0)});
    schedule();
  }
  function draw(){
    for(const {grid,svg,rendered,edges,vertical:compactVertical}of grids){
      const vertical=direction==='vertical'||compactVertical;
      if(!grid.getClientRects().length)continue;const bounds=grid.getBoundingClientRect();svg.setAttribute('viewBox',`0 0 ${grid.offsetWidth} ${grid.offsetHeight}`);
      const marker=instance+'-arrow-'+grid.dataset.marker,defs=doc.createElementNS(ns,'defs');defs.innerHTML=`<marker id="${marker}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M1 1 7 4 1 7" fill="none" stroke="context-stroke" stroke-width="1.25"/></marker>`;
      svg.replaceChildren(defs);const rects=new Map([...rendered].map(([id,node])=>{const r=node.getBoundingClientRect();return [id,{x:(r.left-bounds.left)/scale,y:(r.top-bounds.top)/scale,w:r.width/scale,h:r.height/scale}];}));
      for(const edge of edges){
        if(edge.type==='parallel')continue;let a=rects.get(edge.from),b=rects.get(edge.to);if(!a||!b)continue;
        const path=doc.createElementNS(ns,'path'),reverse=vertical?b.y<=a.y:b.x<=a.x;
        if(reverse&&edge.type!=='revise')continue;
        let d,lx,ly;
        if(vertical){const ax=a.x+a.w/2,ay=a.y+a.h,bx=b.x+b.w/2,by=b.y,m=(ay+by)/2;d=`M${ax} ${ay}C${ax} ${m} ${bx} ${m} ${bx} ${by}`;lx=ax+12;ly=m;}
        else if(reverse){const y=Math.max(a.y+a.h,b.y+b.h)+12;d=`M${a.x+a.w/2} ${a.y+a.h}C${a.x+a.w/2} ${y} ${b.x+b.w/2} ${y} ${b.x+b.w/2} ${b.y+b.h}`;lx=(a.x+b.x)/2;ly=y;}
        else{const ax=a.x+a.w,ay=a.y+a.h/2,bx=b.x,by=b.y+b.h/2,m=(ax+bx)/2;d=`M${ax} ${ay}C${m} ${ay} ${m} ${by} ${bx} ${by}`;lx=m;ly=(ay+by)/2-7;}
        path.setAttribute('d',d);path.setAttribute('marker-end',`url(#${marker})`);path.dataset.type=edge.type;if(edge.inferred!==false||edge.type==='unconfirmed')path.setAttribute('stroke-dasharray','4 4');svg.append(path);
        if(grid.parentElement.parentElement===body){const label=doc.createElementNS(ns,'text');label.setAttribute('x',String(lx));label.setAttribute('y',String(ly));label.setAttribute('text-anchor','middle');label.textContent=edge.type==='revise'?'修订':edge.type==='unconfirmed'?'关系待确认':edge.scope==='work-item'?'子任务串行':'串行';svg.append(label);}
      }
    }
  }
  function schedule(){if(frame||disposed)return;frame=win.requestAnimationFrame(()=>{frame=0;if(!disposed)draw();});}
  const resize=new win.ResizeObserver(schedule);resize.observe(surface);
  function zoom(amount){scale=Math.min(1.5,Math.max(.65,scale*amount));surface.style.zoom=String(scale);surface.style.width=(100/scale)+'%';schedule();return scale;}
  function fit(){scale=1;surface.style.zoom='1';surface.style.width='100%';const width=surface.scrollWidth;scale=Math.max(.65,Math.min(1,(viewport.clientWidth-16)/Math.max(1,width)));surface.style.zoom=String(scale);surface.style.width=(100/scale)+'%';schedule();return scale;}
  function locate(){
    if(!model)return;const item=model.leaves.filter(l=>l.status==='active').at(-1)||model.leaves.at(-1);if(!item)return;
    collapsed.delete(item.parentId);const parent=parents.get(item.parentId);if(parent)applyCollapse(parent);schedule();
    const card=cards.get(item.id)?.card;if(!card)return;const r=card.getBoundingClientRect(),v=viewport.getBoundingClientRect();viewport.scrollTo({left:viewport.scrollLeft+r.left-v.left-(v.width-r.width)/2,top:viewport.scrollTop+r.top-v.top-(v.height-r.height)/2,behavior:'smooth'});card.focus({preventScroll:true});
  }
  viewport.addEventListener('pointerdown',event=>{if(event.button!==0||event.target.closest('button'))return;const content=event.target.closest('.jev-flow-parent-content'),target=content&&(content.scrollWidth>content.clientWidth||content.scrollHeight>content.clientHeight)?content:viewport;drag={x:event.clientX,y:event.clientY,left:target.scrollLeft,top:target.scrollTop,target,pointer:event.pointerId};viewport.setPointerCapture(event.pointerId);viewport.dataset.dragging='true';});
  viewport.addEventListener('pointermove',event=>{if(!drag)return;drag.dx=event.clientX-drag.x;drag.dy=event.clientY-drag.y;if(panFrame)return;panFrame=win.requestAnimationFrame(()=>{panFrame=0;if(drag){drag.target.scrollLeft=drag.left-(drag.dx||0);drag.target.scrollTop=drag.top-(drag.dy||0);}});});
  const stop=()=>{drag=null;viewport.dataset.dragging='false';};viewport.addEventListener('pointerup',stop);viewport.addEventListener('pointercancel',stop);viewport.addEventListener('lostpointercapture',stop);
  return {update,zoom,fit,locate,closeDetail,setDirection(value){const next=value==='vertical'?'vertical':'horizontal';if(next===direction)return;direction=next;root.dataset.direction=next;if(input)update(input.source,input.tasks,input.goal);schedule();},expand(){collapsed.clear();for(const entry of parents.values())applyCollapse(entry);schedule();},dispose(){disposed=true;resize.disconnect();if(frame)win.cancelAnimationFrame(frame);if(panFrame)win.cancelAnimationFrame(panFrame);root.remove();}};
}
