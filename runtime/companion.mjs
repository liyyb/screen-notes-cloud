const norm = s => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const grams = s => { const t=norm(s), out=new Set(); for(let i=0;i<t.length-2;i++)out.add(t.slice(i,i+3)); return out; };
const overlap = (a,b) => { const x=grams(a),y=grams(b); return x.size&&y.size?[...x].filter(v=>y.has(v)).length/Math.min(x.size,y.size):0; };
export function pacing(mode) {
  return ({quiet:{interval:45000,dwell:2000,maxWait:8000},balanced:{interval:10000,dwell:1000,maxWait:4000},active:{interval:5000,dwell:600,maxWait:3000}})[mode] ?? pacing('balanced');
}
/** Session-only context. A generation invalidates in-flight work without touching saved notes. */
export class CompanionSession {
  state='paused';
  transition(phase, enabled=true){this.state = !enabled ? 'paused' : ({capturing:'observing',ocr:'reading',summarizing:'thinking',done:'waiting',error:'recoverable_error',idle:'waiting'}[phase] ?? this.state);}
  generation=0; entries=[]; muted=[]; quietUntil=0;
  invalidate(){this.generation++;this.requestAbort?.abort();this.requestAbort=null;}
  beginRequest(){this.requestAbort?.abort();return (this.requestAbort=new AbortController()).signal;}
  clear(){this.invalidate();this.entries=[];this.muted=[];this.quietUntil=0;}
  isMuted(text){return this.muted.some(t=>overlap(t,text)>.45);}
  context(text){return this.entries.filter(e=>overlap(e.text,text)>.12).slice(-3).map(e=>e.summary).join('\n').slice(0,700);}
  duplicate(summary){return this.entries.slice(-5).some(e=>overlap(e.summary,summary)>.85);}
  remember(text,summary){this.entries.push({text:String(text).slice(0,4000),summary:String(summary).slice(0,500)});this.entries=this.entries.slice(-12);}
}
