import { progressIcon } from './icons.js';

import {taskGraph,layoutTaskGraph} from './graph.js';
import {mountTaskFlow} from './flow.js';

/** Preserve task functions; arrange dependencies and parallel branches. */
export function compactGraph(graph,turn,width=960,messages=[],branch='all') {
  return layoutTaskGraph(taskGraph(graph,turn,messages,branch));
}

/** Compact history for the current request. */
export function progressHistory(state) {
  const entries=new Map();
  for(const message of state?.messages??[]) {
    if(message.kind!=='progress'||message.cancelled)continue;
    if(state.goalSeq!=null&&message.goalSeq!==state.goalSeq)continue;
    for(const part of message.parts?.length?message.parts:[message]) {
      if(!part.cancelled&&part.text)entries.set(part.activity??part.id??part.text,{...part});
    }
  }
  return [...entries.values()].sort((a,b)=>(a.sourceAt??a.at??0)-(b.sourceAt??b.at??0)).slice(-40);
}

export function mountProgress(container, { load, setMode, setAppearance, setSummaryAppearance, setDisplay, setOutputPolicy, setFlowDirection, importKey, checkKey, page = false, expanded = false } = {}) {
  const phase = {understand:'理解需求',research:'查阅资料',plan:'制定方案',implement:'实现功能',verify:'验证结果',debug:'排查问题',deliver:'整理交付',other:'处理任务'};
  const status = {planned:'准备开始',active:'进行中',reported_done:'已报告完成',blocked:'遇到阻碍',completed:'已验证完成',failed:'失败',canceled:'已取消'};
  const edgeName = {continue:'继续',next:'后续',parallel:'并行',revise:'修订',unrelated:'独立'};
  const root = document.createElement('div'); root.className='jev';
  root.innerHTML = `<section class="jev-history" aria-label="进度历史" hidden><header><span>进度历史</span><button class="jev-history-close" aria-label="收起进度历史">×</button></header><div class="jev-history-list"></div></section>
  <div class="jev-bar"><button class="jev-status-toggle" aria-expanded="false" aria-label="展开进度历史"><span class="jev-status-icon"></span><span class="jev-status-native" hidden>思考<span class="jev-native-separator">·</span></span><span class="jev-current" role="status"></span><span class="jev-history-count"></span><svg class="jev-history-chevron" viewBox="0 0 16 16" width="12" height="12" fill="none"><path d="m4 10 4-4 4 4" stroke="currentColor" stroke-width="1.3"/></svg></button><button class="jev-open">流程</button><button class="jev-settings-open" aria-label="进度设置" title="进度设置"><svg viewBox="0 0 20 20" width="16" height="16" fill="none"><path d="M4 5h12M4 10h12M4 15h12" stroke="currentColor" stroke-width="1.2"/><circle cx="7" cy="5" r="2" fill="var(--dsw-alias-bg-base,#fff)" stroke="currentColor"/><circle cx="13" cy="10" r="2" fill="var(--dsw-alias-bg-base,#fff)" stroke="currentColor"/><circle cx="8" cy="15" r="2" fill="var(--dsw-alias-bg-base,#fff)" stroke="currentColor"/></svg></button></div>
  <dialog class="jev-settings-dialog"><header><div><h2>进度设置</h2><p>当前会话 · 自动保存</p></div><button class="jev-settings-close" aria-label="关闭进度设置">×</button></header>
  <div class="jev-setting-section"><label class="jev-setting-label">摘要方式 <select class="jev-mode" aria-label="摘要方式"><option value="light">轻量摘要</option><option value="native">原生翻译</option></select></label><p class="jev-mode-note" role="status"></p></div>
  <div class="jev-setting-section jev-policy-section"><label class="jev-setting-label">输出频率 <select class="jev-frequency" aria-label="输出频率"><option value="less">较少 · 合并小进展</option><option value="standard">适中</option><option value="more">较多 · 保留各项进展</option></select></label><label class="jev-setting-label jev-strictness-label">筛选严格程度 <select class="jev-strictness" aria-label="筛选严格程度"><option value="inclusive">宽松</option><option value="balanced">均衡</option><option value="strict">严格 · 重要进展优先</option></select></label><p>按新信息和内容价值调整，不按固定秒数硬输出。两种摘要方式共用。</p>
  <details class="jev-thresholds"><summary>调整具体阈值</summary><label>新信息置信阈值 <output class="jev-novelty-value"></output><input class="jev-novelty" aria-label="新信息置信阈值" type="range" min="0.5" max="0.95" step="0.05"></label><label>进展置信阈值 <output class="jev-worth-value"></output><input class="jev-worth" aria-label="进展置信阈值" type="range" min="0.3" max="0.95" step="0.05"></label><label>信息重要程度 <output class="jev-significance-value"></output><input class="jev-significance" aria-label="信息重要程度" type="range" min="0" max="4" step="0.2"></label><p>阈值越高，输出越少、筛选越严格。无关细节和重复句子始终过滤。</p><button class="jev-policy-reset" type="button">恢复默认</button></details><p class="jev-policy-note" role="status"></p></div>
  <div class="jev-setting-section"><label class="jev-setting-label">摘要显示 <select class="jev-summary-appearance" aria-label="摘要显示"><option value="plain">原生正文 · 无标识</option><option value="tagged">带小标识</option></select></label><p class="jev-summary-appearance-note" role="status">摘要穿插在对应思考之间，独立于底部进度外观。</p></div>
  <div class="jev-setting-section"><label class="jev-setting-label">流程方向 <select class="jev-flow-direction-setting" aria-label="流程方向"><option value="horizontal">横向 · 从左到右</option><option value="vertical">竖向 · 从上到下</option></select></label><p class="jev-flow-direction-note" role="status">按会话保存，流程窗口也可直接切换。</p></div>
  <div class="jev-setting-section"><label class="jev-setting-label">进度外观 <select class="jev-appearance" aria-label="进度外观"><option value="whale">蓝色动态鲸尾</option><option value="orbit">动态思考</option><option value="native">原生思考标签</option><option value="none">纯文字 · 无标识</option></select></label><div class="jev-appearance-preview" data-jev-animate="true"></div><p class="jev-appearance-note" role="status">执行时播放，结束后静止</p></div>
  <div class="jev-setting-section"><label class="jev-display-label"><span>显示底部进度<small>关闭后保留流程和设置入口</small></span><input class="jev-display-switch" type="checkbox" role="switch" aria-label="显示底部进度" checked></label><p class="jev-display-note" role="status"></p></div>
  <div class="jev-setting-section"><h3>插件调用与费用</h3><div class="jev-usage"></div><p class="jev-usage-note"></p><p>原生翻译不发起轻量摘要调用。JeV 免费，仍受请求与 Token 额度限制；轻量金额为目录估算，不是账单实扣。</p></div>
  <div class="jev-setting-section jev-key-section"><div class="jev-key-heading"><h3>JeV 连接</h3><span class="jev-key-state"></span></div>
  <details class="jev-key-guide"><summary>获取并导入免费 JeV Key</summary><ol><li>打开 <a href="https://decision.vllm-sr.ai/" target="_blank" rel="noopener noreferrer">JeV 官方页面 ↗</a>，点击 Get API key，按官网提示确认条款。</li><li>复制生成的 Key。官网只显示一次，请自行保存。</li><li>粘贴到下方，点击“验证并导入”。显示“已配置”后即可使用。</li></ol><p>JeV 用于筛选工作进展；轻量摘要使用 DeepSeek Flash，按当前会话所用渠道计费。<a href="https://decision.vllm-sr.ai/docs" target="_blank" rel="noopener noreferrer">额度与服务说明 ↗</a></p></details>
  <form class="jev-key-form"><label>JeV API Key<input class="jev-key-input" type="password" autocomplete="off" spellcheck="false" placeholder="粘贴 sk-vsr- 开头的 Key" aria-label="JeV API Key"></label><div><button class="jev-key-import" type="submit">验证并导入</button><button class="jev-key-check" type="button">检查连接</button></div></form><p class="jev-key-note" role="status">Key 保存到本机凭据存储，不进入会话或模型上下文。</p></div></dialog>
  <dialog class="jev-dialog jev-flow-dialog"><header><div><h2>任务流程</h2><p class="jev-subtitle"></p></div><button class="jev-close" aria-label="关闭流程图">×</button></header>
  <div class="jev-toolbar"><span class="jev-live"></span><select class="jev-turn" aria-label="选择任务轮次"></select><select class="jev-branch" aria-label="任务或功能分支"><option value="all">全部任务与分支</option></select><select class="jev-flow-direction" aria-label="流程排列方向"><option value="horizontal">横向流程</option><option value="vertical">竖向流程</option></select><span class="jev-caption"><i class="jev-legend-serial"></i>串行 <i class="jev-legend-parallel"></i>并行 <i class="jev-legend-parent"></i>父子</span><div class="jev-flow-actions"><button class="jev-locate">定位当前</button><button class="jev-expand-all">展开全部</button><div class="jev-zoom-controls"><button class="jev-minus" aria-label="缩小">−</button><span class="jev-scale">100%</span><button class="jev-plus" aria-label="放大">＋</button><button class="jev-fit">适应宽度</button></div></div></div>
  <div class="jev-main"><div class="jev-flow-host"></div></div>
  <footer><span>父任务包含子任务 · 点击节点查看进展</span><span class="jev-metrics"></span></footer></dialog>`;
  container.append(root);
  if(page){root.classList.add('jev-plugin-page');root.querySelector('.jev-settings-dialog').setAttribute('open','');root.querySelector('.jev-settings-dialog h2').textContent='调用用量与 JeV 连接';root.querySelector('.jev-settings-dialog header p').textContent='本机保留的会话 · 统一记录';}
  const q=s=>root.querySelector(s), dialog=q('.jev-flow-dialog'), settings=q('.jev-settings-dialog');
  const toggleHistory=(close=!q('.jev-history').hidden)=>{
    q('.jev-history').hidden=close;q('.jev-status-toggle').setAttribute('aria-expanded',String(!close));
  };
  q('.jev-status-toggle').onclick=()=>toggleHistory();
  q('.jev-history-close').onclick=()=>toggleHistory(true);
  q('.jev-settings-open').onclick=()=>{toggleHistory(true);settings.showModal();q('.jev-mode').focus();};
  q('.jev-settings-close').onclick=()=>settings.close();
  const outside=e=>{if(!root.contains(e.target))toggleHistory(true);};
  container.ownerDocument.addEventListener('pointerdown',outside);
  root.addEventListener('keydown',e=>{if(e.key==='Escape')toggleHistory(true);});
  let current=null,disposed=false,timer,running=false,signature='',selectedTurn=null,selectedBranch='all';
  let connectionStatus={},billingStatus={},keyBusy=false,policySaving=false,selectedPolicy={frequency:'standard',strictness:'balanced',novelty:.7,worth:.5,significance:.5};
  let selectedMode='light',modeSaving=false,requestVersion=0;
  let selectedAppearance='whale',appearanceSaving=false,historySignature='';
  let summaryAppearanceSaving=false,selectedSummaryAppearance='plain';
  const policyControls=['.jev-frequency','.jev-strictness','.jev-novelty','.jev-worth','.jev-significance','.jev-policy-reset'];
  function showPolicy(){
    q('.jev-frequency').value=selectedPolicy.frequency;q('.jev-strictness').value=selectedPolicy.strictness;
    for(const key of ['novelty','worth','significance']){q('.jev-'+key).value=selectedPolicy[key];q('.jev-'+key+'-value').textContent=Number(selectedPolicy[key]).toFixed(key==='significance'?1:2);}
  }
  async function savePolicy(policy){
    if(policySaving||!setOutputPolicy)return;policySaving=true;requestVersion++;
    policyControls.forEach(selector=>q(selector).disabled=true);q('.jev-policy-note').textContent='正在保存…';
    try{const value=await setOutputPolicy(policy);if(disposed)return;selectedPolicy=value.state.outputPolicy;render(value);q('.jev-policy-note').textContent='已保存，对后续进展生效。';}
    catch{if(!disposed)q('.jev-policy-note').textContent='未能保存，请重试。';}
    finally{policySaving=false;if(!disposed){showPolicy();policyControls.forEach(selector=>q(selector).disabled=!setOutputPolicy);}}
  }
  q('.jev-frequency').onchange=()=>{const p={...selectedPolicy,frequency:q('.jev-frequency').value};delete p.novelty;void savePolicy(p);};
  q('.jev-strictness').onchange=()=>{const p={...selectedPolicy,strictness:q('.jev-strictness').value};delete p.worth;delete p.significance;void savePolicy(p);};
  for(const key of ['novelty','worth','significance']){q('.jev-'+key).oninput=()=>q('.jev-'+key+'-value').textContent=Number(q('.jev-'+key).value).toFixed(key==='significance'?1:2);q('.jev-'+key).onchange=()=>void savePolicy({...selectedPolicy,[key]:Number(q('.jev-'+key).value)});}
  q('.jev-policy-reset').onclick=()=>void savePolicy({});showPolicy();
  const keyErrors={invalid_key:'Key 格式不正确，请只粘贴 sk-vsr- 开头的 Key。',key_unauthorized:'Key 未通过验证，请重新复制有效的 Key。',key_inactive:'这个 Key 已失效，请在官网申请新 Key。',key_network_error:'暂时无法连接 JeV，请检查网络后重试。',key_rate_limited:'JeV 当前请求较多，请稍后重试。',key_save_failed:'未能保存 Key，请重试。',key_storage_unavailable:'当前环境暂不支持保存 Key，可配置 JEV_API_KEY 后使用。',key_service_error:'JeV 服务暂不可用，请稍后重试。',key_invalid_response:'JeV 返回了无法识别的连接信息。',key_busy:'正在处理连接，请稍候。'};
  async function keyAction(importing){
    if(keyBusy)return;keyBusy=true;requestVersion++;
    q('.jev-key-import').disabled=true;q('.jev-key-check').disabled=true;
    q('.jev-key-note').textContent=importing?'正在验证并保存 Key…':'正在检查连接…';
    try{
      const value=importing?await importKey(q('.jev-key-input').value):await checkKey();
      if(disposed)return;q('.jev-key-input').value='';render(page?await load():value);
      q('.jev-key-note').textContent=importing?'已连接，Key 已保存。新的进展会自动显示。':'连接正常。';
    }catch(error){if(!disposed)q('.jev-key-note').textContent=keyErrors[error.message]??'操作未完成，请重试。';}
    finally{keyBusy=false;if(!disposed){q('.jev-key-import').disabled=!importKey||connectionStatus.writable===false;q('.jev-key-check').disabled=!checkKey||!connectionStatus.configured;}}
  }
  q('.jev-key-form').onsubmit=event=>{event.preventDefault();void keyAction(true);};
  q('.jev-key-check').onclick=()=>void keyAction(false);
  settings.addEventListener('close',()=>{q('.jev-key-input').value='';});
  q('.jev-summary-appearance').disabled=!setSummaryAppearance;
  q('.jev-summary-appearance').onchange=async()=>{
    const appearance=q('.jev-summary-appearance').value,previous=selectedSummaryAppearance;
    requestVersion++;summaryAppearanceSaving=true;q('.jev-summary-appearance').disabled=true;
    q('.jev-summary-appearance-note').textContent='正在保存…';
    try {
      const result=await setSummaryAppearance(appearance);if(disposed)return;
      summaryAppearanceSaving=false;render(result);
      q('.jev-summary-appearance-note').textContent='已保存 · 摘要穿插在对应思考之间。';
    } catch {
      if(disposed)return;
      q('.jev-summary-appearance').value=previous;
      q('.jev-summary-appearance-note').textContent='未能保存，请重试';
    } finally {summaryAppearanceSaving=false;if(!disposed)q('.jev-summary-appearance').disabled=!setSummaryAppearance;}
  };
  let directionSaving=false,selectedFlowDirection='horizontal';
  async function saveFlowDirection(direction){
    if(directionSaving||!setFlowDirection)return;const previous=selectedFlowDirection;requestVersion++;directionSaving=true;selectedFlowDirection=direction;
    for(const selector of ['.jev-flow-direction','.jev-flow-direction-setting']){q(selector).disabled=true;q(selector).value=direction;}flow.setDirection(direction);q('.jev-flow-direction-note').textContent='正在保存…';
    try{const result=await setFlowDirection(direction);if(disposed)return;directionSaving=false;render(result);q('.jev-flow-direction-note').textContent='已保存 · 切换不影响任务记录和模型上下文';}
    catch{if(disposed)return;selectedFlowDirection=previous;flow.setDirection(previous);for(const selector of ['.jev-flow-direction','.jev-flow-direction-setting'])q(selector).value=previous;q('.jev-flow-direction-note').textContent='未能保存，请重试';}
    finally{directionSaving=false;if(!disposed)for(const selector of ['.jev-flow-direction','.jev-flow-direction-setting'])q(selector).disabled=!setFlowDirection;}
  }
  for(const selector of ['.jev-flow-direction','.jev-flow-direction-setting']){q(selector).disabled=!setFlowDirection;q(selector).onchange=()=>saveFlowDirection(q(selector).value);}
  let displaySaving=false;
  q('.jev-display-switch').disabled=!setDisplay;
  q('.jev-display-switch').onchange=async()=>{
    const visible=q('.jev-display-switch').checked,previous=!visible;
    requestVersion++;displaySaving=true;q('.jev-display-switch').disabled=true;
    root.dataset.showStatusBar=String(visible);if(!visible)toggleHistory(true);
    try {
      const result=await setDisplay(visible);if(disposed)return;
      displaySaving=false;render(result);q('.jev-display-note').textContent='已保存';
    } catch {
      if(disposed)return;
      q('.jev-display-switch').checked=previous;root.dataset.showStatusBar=String(previous);
      q('.jev-display-note').textContent='未能保存，请重试';
    } finally {displaySaving=false;if(!disposed)q('.jev-display-switch').disabled=!setDisplay;}
  };
  const showAppearance=()=>{
    const target=q('.jev-appearance-preview');
    if(target.dataset.appearance!==selectedAppearance) {
      target.dataset.appearance=selectedAppearance;
      target.innerHTML=progressIcon(selectedAppearance)+(selectedAppearance==='native'?'<span>思考<span class="jev-native-separator">·</span></span>':'')+'<span class="jev-preview-text">正在梳理任务方案</span>';
    }
    q('.jev-appearance').value=selectedAppearance;
    const holder=q('.jev-status-icon');
    if(holder.dataset.appearance!==selectedAppearance) {
      holder.dataset.appearance=selectedAppearance;holder.innerHTML=progressIcon(selectedAppearance);
    }
    holder.hidden=selectedAppearance==='none';q('.jev-status-native').hidden=selectedAppearance!=='native';
  };
  q('.jev-appearance').disabled=!setAppearance;
  q('.jev-appearance').onchange=async()=>{
    const appearance=q('.jev-appearance').value,previous=selectedAppearance;
    requestVersion++;appearanceSaving=true;q('.jev-appearance').disabled=true;
    selectedAppearance=appearance;showAppearance();
    q('.jev-appearance-note').textContent='正在保存…';
    try{
      const result=await setAppearance(appearance);
      if(disposed)return;
      appearanceSaving=false;render(result);
      q('.jev-appearance-note').textContent='已保存 · 执行时播放，结束后静止';
    }catch{
      if(disposed)return;
      selectedAppearance=previous;showAppearance();
      q('.jev-appearance-note').textContent='未能保存，请重试';
    }finally{appearanceSaving=false;if(!disposed)q('.jev-appearance').disabled=!setAppearance;}
  };
  const modeNote=()=>q('.jev-mode-note').textContent=(selectedMode==='native'?
    '翻译模型自己的规划、小结和明确进展，不调用摘要模型。':'独立轻量调用，整理成自然中文。')+' 对本会话的新进展生效。';
  q('.jev-mode').disabled=!setMode;
  q('.jev-mode').onchange=async()=>{
    const mode=q('.jev-mode').value,previous=selectedMode;
    requestVersion++;modeSaving=true;q('.jev-mode').disabled=true;
    q('.jev-mode-note').textContent='正在保存…';
    try {
      const result=await setMode(mode);
      if(disposed)return;
      selectedMode=mode;modeSaving=false;render(result);modeNote();
    } catch {
      if(disposed)return;
      selectedMode=previous;q('.jev-mode').value=previous;
      q('.jev-mode-note').textContent='未能保存，仍使用原来的方式，请重试。';
    } finally {modeSaving=false;if(!disposed)q('.jev-mode').disabled=!setMode;}
  };
  const flow=mountTaskFlow(q('.jev-flow-host'),{phase,status,onMetrics:metrics=>{
    q('.jev-metrics').textContent=`${metrics.groups} 组任务 · ${metrics.leaves} 项工作 · ${metrics.parallel} 组并行 · ${metrics.records} 条记录`;
    q('.jev-dialog footer>span:first-child').textContent=metrics.relations?'实线表示已记录关系，虚线表示模型判断 · 点击节点查看历史':'父任务包含子任务 · 未记录的依赖关系不会补画';
  }});
  const showScale=value=>q('.jev-scale').textContent=Math.round(value*100)+'%';
  function open(){toggleHistory(true);if(!dialog.open)dialog.showModal();selectedTurn=null;selectedBranch='all';signature='';renderGraph();q('.jev-close').focus();}
  q('.jev-open').onclick=open;q('.jev-close').onclick=()=>dialog.close();
  q('.jev-plus').onclick=()=>showScale(flow.zoom(1.2));q('.jev-minus').onclick=()=>showScale(flow.zoom(1/1.2));q('.jev-fit').onclick=()=>showScale(flow.fit());q('.jev-locate').onclick=()=>flow.locate();q('.jev-expand-all').onclick=()=>flow.expand();
  q('.jev-turn').onchange=()=>{selectedTurn=q('.jev-turn').value;selectedBranch='all';signature='';renderGraph();};
  q('.jev-branch').onchange=()=>{selectedBranch=q('.jev-branch').value;signature='';renderGraph();};
  dialog.addEventListener('cancel',event=>{if(flow.closeDetail())event.preventDefault();});
  function text(tag,className,content) { const el=document.createElement(tag);el.className=className;el.textContent=content;return el; }
  function renderHistory() {
    const entries=progressHistory(current),sig=JSON.stringify(entries);
    q('.jev-history-count').textContent=entries.length?String(entries.length):'';
    if(sig===historySignature)return;historySignature=sig;
    const list=q('.jev-history-list');list.replaceChildren();
    if(!entries.length)list.append(text('p','jev-history-empty','有新进展后，历史会保存在这里。'));
    entries.forEach((entry,index)=>{
      const row=text('div','jev-history-item','');
      row.append(text('span','jev-history-marker',index===entries.length-1?'●':'·'),text('p','',entry.text));
      list.append(row);
    });
  }
  function renderUsage() {
    const holder=q('.jev-usage');holder.replaceChildren();
    for(const [name,usage,free] of [['JeV 判断',current?.jevUsage,true],['轻量摘要',current?.lightUsage,false]]){
      const card=text('div','jev-usage-card','');card.append(text('h4','',name));
      card.append(text('p','jev-usage-tokens',`${usage?.calls??0} 次 · 输入 ${usage?.inputTokens??0} · 缓存 ${(usage?.cacheReadTokens??0)+(usage?.cacheWriteTokens??0)} · 输出 ${usage?.outputTokens??0} Token`));
      const costs=Object.entries(usage?.costs??{}).map(([currency,cost])=>(currency==='CNY'?'¥':'$')+cost.low.toFixed(6)+(cost.high>cost.low?' ～ '+cost.high.toFixed(6):''));
      card.append(text('div','jev-usage-amount',free?'免费 · $0':costs.length?costs.join('；')+' · 目录估算':'费用待定价'));
      if(!free&&(usage?.calls??0)>(usage?.pricedCalls??0))card.append(text('p','jev-usage-outcomes',`${usage.calls-(usage.pricedCalls??0)} 次费用待确认`));
      if(usage?.calls)card.append(text('p','jev-usage-outcomes',`成功 ${usage.successful??0} · 失败 ${usage.failed??0} · 取消 ${usage.cancelled??0}`+(usage.missingUsage?` · ${usage.missingUsage} 次未返回用量`:'')));
      holder.append(card);
    }
    q('.jev-usage-note').textContent=billingStatus.compatible?
      `已接入 dsh-cost-meter · ${billingStatus.pending?'有 '+billingStatus.pending+' 条记录等待同步':'调用归入当前会话，按用途分别记录'}`:
      billingStatus.connected?'本插件已记录用量，更新 dsh-cost-meter 后可同步新的辅助调用。':'本插件独立记录用量；安装兼容版 dsh-cost-meter 后可统一查看。';
    q('.jev-key-state').textContent=connectionStatus.configured?'已配置':'未配置';
    q('.jev-key-state').dataset.connected=String(!!connectionStatus.configured);
    if(!keyBusy){q('.jev-key-import').disabled=!importKey||connectionStatus.writable===false;q('.jev-key-check').disabled=!checkKey||!connectionStatus.configured;}
  }
  function renderGraph(){
    if(!dialog.open||!current)return;
    const turns=[...new Set([...(current.graph?.nodes??[]),...(current.messages??[])].map(node=>node.turn).filter(turn=>turn!=null))].sort((a,b)=>Number(a)-Number(b));
    if(selectedTurn===null||!turns.some(turn=>String(turn)===String(selectedTurn)))selectedTurn=turns.at(-1)??null;
    const selector=q('.jev-turn');
    if([...selector.options].map(o=>o.value).join(',')!==turns.map(String).join(','))selector.replaceChildren(...turns.map(turn=>{const option=text('option','',`第 ${turn} 轮`);option.value=String(turn);return option;}));
    selector.value=String(selectedTurn);
    const tasks=current.graph?.tasks??[];
    const sig=JSON.stringify([selectedTurn,selectedBranch,current.graph?.lastUpdatedAt,current.nodeSequence,current.messageSequence,current.lastProgress,current.stats?.narrated,current.graph?.nodes?.length,tasks]);
    if(sig===signature)return;signature=sig;
    const all=taskGraph(current.graph,selectedTurn,current.messages??[]),branchSelector=q('.jev-branch'),branchSig=JSON.stringify(all.branches);
    if(branchSelector.dataset.options!==branchSig){branchSelector.dataset.options=branchSig;branchSelector.replaceChildren(Object.assign(text('option','','全部任务与分支'),{value:'all'}),...all.branches.map(branch=>Object.assign(text('option','',branch.title),{value:branch.id})));}
    if(selectedBranch!=='all'&&!all.branches.some(b=>b.id===selectedBranch))selectedBranch='all';branchSelector.value=selectedBranch;
    const projection=selectedBranch==='all'?all:taskGraph(current.graph,selectedTurn,current.messages??[],selectedBranch),taskIds=new Set(projection.nodes.map(node=>node.taskId));
    const visibleTasks=selectedBranch==='all'&&String(selectedTurn)===String(turns.at(-1)??null)?tasks:tasks.filter(task=>taskIds.has(task.id));
    flow.update(projection,visibleTasks,current.taskGoal||current.title||'当前任务');
  }
  function render(data) {
    connectionStatus=data?.connection??connectionStatus;billingStatus=data?.billingIntegration??billingStatus;
    current=data?.state??data;
    if(!directionSaving){selectedFlowDirection=(current?.flowDirection??data?.flowDirection)==='vertical'?'vertical':'horizontal';flow.setDirection(selectedFlowDirection);for(const selector of ['.jev-flow-direction','.jev-flow-direction-setting'])q(selector).value=selectedFlowDirection;}
    if(!policySaving){selectedPolicy=current?.outputPolicy??selectedPolicy;showPolicy();}
    if(!displaySaving) {
      const visible=(current?.showStatusBar??data?.showStatusBar)!==false;
      root.dataset.showStatusBar=String(visible);q('.jev-display-switch').checked=visible;
      if(!visible)toggleHistory(true);
    }
    if(!appearanceSaving) {
      selectedAppearance=current?.appearance??data?.appearance??'whale';showAppearance();
    }
    if(!summaryAppearanceSaving) {
      selectedSummaryAppearance=current?.summaryAppearance??data?.summaryAppearance??'plain';
      q('.jev-summary-appearance').value=selectedSummaryAppearance;
    }
    if(!modeSaving) {
      selectedMode=current?.summaryMode??data?.summaryMode??'light';
      q('.jev-mode').value=selectedMode;modeNote();
    }
    if(!current?.graph) {
      const observation = {
        disabled:'任务进度已关闭',
        workspace_filtered:'当前工作区未启用任务进度',
        unsupported_model:'当前模型未启用 JeV 任务进度',
        not_observed:'本会话尚无进度记录，下一次执行时开始显示',
        listening:'已接入任务，等待完整段落'
      };
      q('.jev-current').textContent=data?.configured===false?'请配置 JeV 密钥':
        data?.enabled===false?observation.disabled:observation[data?.observation]||'等待任务开始';
      q('.jev-bar').dataset.jevAnimate='false';renderHistory();renderUsage();
      return;
    }
    const latest=(current.messages??[]).filter(message=>message.kind==='progress'&&!message.cancelled&&
      (current.goalSeq==null||message.goalSeq===current.goalSeq)).sort((a,b)=>(b.at??0)-(a.at??0))[0];
    const label=current.issue||latest?.text||current.message||'正在梳理任务思路';
    if(q('.jev-current').textContent!==label)q('.jev-current').textContent=label;
    q('.jev-bar').dataset.jevAnimate=String(current.running===true);
    renderHistory();renderUsage();
    q('.jev-subtitle').textContent=current.title||'当前任务';
    q('.jev-live').textContent=current.issue||`${current.running?'● 正在执行':'○ 本轮已结束'}${current.busy?' · 正在整理进度':''}`;
    renderGraph();
    if(!dialog.open)q('.jev-metrics').textContent='打开流程后显示任务关系';
  }
  async function poll() {
    if(disposed||running)return;running=true;
    const version=requestVersion;
    try{const result=await load();if(!disposed&&version===requestVersion&&!modeSaving&&!appearanceSaving&&!displaySaving&&!summaryAppearanceSaving&&!policySaving&&!keyBusy&&!directionSaving)render(result);}
    catch{if(!disposed)q('.jev-current').textContent='正在重新连接进度服务';}
    finally{running=false;if(!disposed)timer=setTimeout(poll,page?5000:dialog.open?750:1500);}
  }
  void poll();if(expanded)open();
  return { render, open, dispose(){disposed=true;clearTimeout(timer);flow.dispose();dialog.close();settings.close();container.ownerDocument.removeEventListener('pointerdown',outside);root.remove();} };
}
