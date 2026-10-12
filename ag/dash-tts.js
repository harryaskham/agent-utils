/* Read-only speech view. One EventSource per visible pane; the collector is
 * process-owned and continues when this view disconnects. No localStorage of
 * private speech and no audio playback. */
(()=>{
'use strict';
const $=id=>document.getElementById(id);
const node=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e};
const MAX=500;
let records=[],nodes=new Map(),cursor=null,source=null,visible=false,enabled=true,running=true;
let following=true,pending=0,timer=null,connection='Connecting…',notice='',evicted=0;
const list=$('tts-log'),follow=$('tts-follow'),host=$('tts-host'),kind=$('tts-kind'),search=$('tts-search');
const time=value=>{const d=new Date(value);return Number.isNaN(d.getTime())?value:d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})};
function schedule(force=false){
  if(force){clearTimeout(timer);timer=null;render();return}
  if(!visible||document.hidden||timer)return;
  timer=setTimeout(()=>{timer=null;if(following)render();else statusBar()},100);
}
function setFollowing(value){following=value;if(value){pending=0;schedule(true)}statusBar()}
function statusBar(){
  if(!visible||document.hidden)return;
  const connected=[...nodes.values()].filter(n=>n.state==='connected').length;
  const offline=[...nodes.values()].filter(n=>n.state==='offline').length;
  const errors=[...nodes.values()].filter(n=>n.state==='error'||n.state==='warning').length;
  $('tts-connection').textContent=!enabled?'Disabled':!running?'Collector stopped':connection;
  $('tts-connection').className=source?.readyState===1?'feed-live':'feed-muted';
  $('tts-nodes-summary').textContent=`${connected}/${nodes.size} live`+(offline?` · ${offline} offline`:'')+(errors?` · ${errors} error`:'');
  $('tts-nodes-summary').classList.toggle('feed-error',errors>0);
  const details=$('tts-nodes-list');details.replaceChildren();
  for(const n of nodes.values()){
    const row=node('li','feed-node '+n.state);
    row.append(node('b','mono',n.host),node('span','',n.state),node('small','',n.message));details.append(row);
  }
  follow.textContent=following?'Pause':pending?`Live · ${pending>=MAX?'500+':pending} new`:'Follow live';
  follow.setAttribute('aria-pressed',String(following));
  $('tts-notice').textContent=notice;
  $('tts-count').textContent=`${records.length} recent`+(evicted?' · bounded history':'');
}
function updateHosts(){
  const current=host.value;
  const names=[...nodes.keys()].sort();
  if(host.dataset.names===JSON.stringify(names))return;
  host.dataset.names=JSON.stringify(names);host.replaceChildren(new Option('All nodes',''),...names.map(n=>new Option(n,n)));host.value=names.includes(current)?current:'';
}
function matches(entry){
  const r=entry.record,q=search.value.trim().toLowerCase();
  return (!host.value||entry.node.host===host.value)&&(!kind.value||r.kind===kind.value)&&(!q||[r.agent,r.session,r.text,entry.node.host].some(v=>v?.toLowerCase().includes(q)));
}
function render(){
  if(!visible||document.hidden)return;
  updateHosts();
  const oldTop=list.scrollTop,fragment=document.createDocumentFragment(),filtered=records.filter(matches);
  for(const entry of filtered){
    const r=entry.record,row=node('article','speech');row.dataset.id=entry.id;
    const meta=node('div','speech-meta'),clock=node('time','',time(r.timestamp));clock.dateTime=r.timestamp;clock.title=r.timestamp;
    const type=node('span','speech-kind',r.kind||'speech');type.dataset.kind=r.kind;
    const agent=node('b','speech-agent',r.agent||r.session||'unknown');agent.title=[r.session,r.cwd].filter(Boolean).join('\n');
    meta.append(clock,node('span','speech-host',entry.node.host),type,agent);
    row.append(meta,node('div','speech-text',r.text));
    if(r.truncated)row.append(node('small','feed-muted','Entry shortened · full text remains on the source node'));
    fragment.append(row);
  }
  if(!filtered.length){
    const empty=node('div','empty');empty.append(node('strong','',!enabled?'Speech feed disabled':!running?'Speech collector stopped':records.length?'No matching speech':source?.readyState===1?'Waiting for speech':'Connecting to speech…'));fragment.append(empty);
  }
  list.replaceChildren(fragment);
  if(following)list.scrollTop=list.scrollHeight;else list.scrollTop=oldTop;
  statusBar();
}
function accept(entry){
  // Server ordering is authoritative. EventSource duplicates are ignored, but
  // a new process/expired cursor replaces the entire view via snapshot.
  if(entry.id===cursor)return;
  cursor=entry.id;nodes.set(entry.node.host,entry.node);
  if(entry.type==='speech'){
    records.push(entry);if(records.length>MAX)records.splice(0,records.length-MAX);
    if(!following)pending=Math.min(MAX,pending+1);
  }
  schedule();
}
function open(){
  if(source||!visible||document.hidden||!enabled)return;
  if(!navigator.onLine){connection='Reconnecting…';statusBar();return}
  connection='Connecting…';statusBar();
  const es=new EventSource('/api/tts/events'+(cursor?'?after='+encodeURIComponent(cursor):''));source=es;
  es.onopen=()=>{if(source!==es)return;connection='Live';statusBar()};
  es.onerror=()=>{if(source!==es)return;connection='Reconnecting…';statusBar()};
  es.addEventListener('snapshot',event=>{
    if(source!==es)return;
    const data=JSON.parse(event.data);
    records=data.records;nodes=new Map(data.nodes.map(n=>[n.host,n]));cursor=data.event_id;
    enabled=data.enabled;running=data.running;evicted=data.evicted_events;
    if(['expired','restarted','invalid'].includes(data.reason))notice=data.reason==='restarted'?'Dashboard restarted · recent history restored':'History window advanced · recent speech restored';
    if(!following)pending=Math.min(MAX,pending+records.length);
    updateHosts();if(!enabled)close();schedule();
  });
  es.addEventListener('feed',event=>{if(source===es)accept(JSON.parse(event.data))});
}
function close(){source?.close();source=null;clearTimeout(timer);timer=null}
follow.onclick=()=>setFollowing(!following);
for(const input of[host,kind,search])input.addEventListener('input',()=>schedule(true));
// Programmatic render scrolls are synchronous; only an actual move away from
// the tail pauses. Returning to the bottom resumes, without changing filters.
list.addEventListener('scroll',()=>{
  const atEnd=list.scrollHeight-list.clientHeight-list.scrollTop<24;
  if(following&&!atEnd)setFollowing(false);
  else if(!following&&atEnd)setFollowing(true);
},{passive:true});
window.agTts={
  visibility(value){visible=value;if(value){open();schedule(true)}else close()},
  status(value){
    if(!value)return;
    enabled=value.enabled;running=value.running;evicted=value.evicted_events;
    if(!cursor){nodes=new Map(value.nodes.map(n=>[n.host,n]));updateHosts()}
    $('b-tts').textContent=enabled?'live':'off';
    if(!enabled){close();schedule(true)}else open();
    statusBar();
  },
  close(){visible=false;close()},
};
document.addEventListener('visibilitychange',()=>{if(document.hidden)close();else{open();schedule(true)}});
window.addEventListener('offline',()=>{close();connection='Reconnecting…';statusBar()});
window.addEventListener('online',open);
window.addEventListener('pagehide',close);
window.addEventListener('pageshow',()=>{open();schedule(true)});
visible=!$('tts').hidden;if(visible){open();schedule(true)}
})();
