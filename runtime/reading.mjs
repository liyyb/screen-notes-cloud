/** Spatial reading focus and bounded, session-only memory of successfully read content. */
const norm = text => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const meaningful = text => (String(text).match(/[\p{L}\p{N}]/gu) ?? []).length;
function noise(text) {
  const flat = text.replace(/\s/g, '');
  return /https?:|www\.|(?:%[0-9a-f]{2}){3}|[?&](?:url|token|utm_|sign|uid)=/i.test(flat) ||
    /^(?:首页|关注|点赞|收藏|分享|更多|评论|登录|投稿|广告|热门主题|点击下翻|字幕中|聊聊这页|收藏这条灵感)$/.test(flat);
}
export function selectReadingContent(ocr, options = {}) {
  const width = Number(ocr.width) || 1920, height = Number(ocr.height) || 1080;
  const segments = [];
  for (const line of ocr.layout ?? []) {
    const words = [...(line.words ?? [])].filter(w => w.w > 0 && w.h > 0).sort((a,b) => a.x-b.x);
    let group = [];
    const finish = () => {
      if (!group.length) return;
      const x = Math.min(...group.map(w=>w.x)), y = Math.min(...group.map(w=>w.y));
      const right = Math.max(...group.map(w=>w.x+w.w)), bottom = Math.max(...group.map(w=>w.y+w.h));
      const text = group.map(w=>w.text).join(' ').replace(/([\u3400-\u9fff]) +(?=[\u3400-\u9fff])/g,'$1');
      if (!noise(text) && meaningful(text)>=4) segments.push({text,x,y,w:right-x,h:bottom-y});
      group=[];
    };
    for (const word of words) {
      const last = group.at(-1);
      if (last && word.x-(last.x+last.w)>Math.max(28,Math.min(last.h,word.h)*2.2)) finish();
      group.push(word);
    }
    finish();
  }
  const allText=segments.map(l=>l.text).join('\n');
  const hint=String(options.title??'');
  const codeLines=segments.filter(l=>/(?:\b(?:function|const|import|return|class|export|def|async)\b|[{};]|=>)/.test(l.text));
  const chatHint=/微信|聊天|WeChat|Discord|Telegram/i.test(hint) || segments.filter(l=>/^(?:成员|用户|我|对方|你|他|她)[\w\u3400-\u9fff]*[：:]/.test(l.text)).length>=3;
  const mode=options.mode&&options.mode!=='auto'?options.mode:
    codeLines.length>=3?'code':chatHint?'chat':/\.pdf|PDF|论文/i.test(hint)?'document':'article';
  function selected(lines,strategy,confidence){
    const ordered=[...lines].sort((a,b)=>a.y-b.y||a.x-b.x);
    const x=Math.min(...lines.map(l=>l.x)),y=Math.min(...lines.map(l=>l.y));
    const r=Math.max(...lines.map(l=>l.x+l.w)),b=Math.max(...lines.map(l=>l.y+l.h));
    return {text:ordered.map(l=>l.text).join('\n'),lines:ordered,rect:{x:Math.max(0,x-8),y:Math.max(0,y-8),w:Math.min(width-x+8,r-x+16),h:Math.min(height-y+8,b-y+16)},strategy,mode,confidence,width,height};
  }
  if(options.rect){
    const r=options.rect;
    const lines=segments.filter(l=>l.x+l.w/2>=r.x&&l.x+l.w/2<=r.x+r.w&&l.y+l.h/2>=r.y&&l.y+l.h/2<=r.y+r.h);
    if(lines.length)return {...selected(lines,'user-region',1),rect:r};
    return {text:'',lines:[],rect:r,strategy:'user-region',mode,confidence:0,width,height};
  }
  if(mode==='code'){
    const candidates=segments.filter(l=>l.x>width*.12&&l.y>height*.08&&l.y<height*.94);
    if(candidates.length>=3)return selected(candidates,'code-editor',.75);
  }
  if(mode==='chat'){
    const candidates=segments.filter(l=>l.x>width*.26&&l.x<width*.93&&l.y>height*.12&&l.y<height*.89);
    if(candidates.length>=3)return selected(candidates,'conversation',.75);
  }
  const body = segments.filter(l=>l.y>height*0.105 && l.y<height*0.965 && l.w>width*0.105 && meaningful(l.text)>=14);
  const groups = [];
  for(const line of body.sort((a,b)=>a.x-b.x)) {
    let g=groups.find(g=>Math.abs(g.x-line.x)<Math.max(34,width*.018));
    if(!g){g={x:line.x,lines:[]};groups.push(g);}g.lines.push(line);
  }
  const scored=groups.map(g=>{
    g.lines.sort((a,b)=>a.y-b.y);
    const chars=g.lines.reduce((s,l)=>s+meaningful(l.text),0);
    const span=Math.max(...g.lines.map(l=>l.y+l.h))-g.lines[0].y;
    const gaps=g.lines.slice(1).map((l,i)=>Math.max(0,l.y-g.lines[i].y-g.lines[i].h));
    const continuous=gaps.length?gaps.filter(v=>v<height*.035).length/gaps.length:0;
    const medianWidth=[...g.lines].sort((a,b)=>a.w-b.w)[Math.floor(g.lines.length/2)].w;
    return {...g,score:chars*(1+Math.min(1,span/height))*(1+Math.min(.5,g.lines.length/30))*(.7+.3*continuous)*(.7+.3*Math.min(1,medianWidth/(width*.25)))};
  }).sort((a,b)=>b.score-a.score);
  const best=scored[0];
  if(mode==='document'&&best){
    const columns=scored.filter(g=>g.lines.length>=4&&g.score>=best.score*.55).sort((a,b)=>a.x-b.x).slice(0,3);
    if(columns.length>=2){
      const lines=columns.flatMap(g=>g.lines);
      const result=selected(lines,'document-columns',.85);
      result.text=columns.map(g=>g.lines.map(l=>l.text).join('\n')).join('\n\n');
      return result;
    }
  }
  if(best && best.lines.length>=3 && best.lines.reduce((s,l)=>s+l.text.length,0)>=80){
    const x=Math.min(...best.lines.map(l=>l.x)), right=Math.max(...best.lines.map(l=>l.x+l.w));
    // Keep headings/short final lines within the dominant column as well.
    const chosen=segments.filter(l=>l.y>height*.105 && l.y<height*.965 && l.x>=x-40 && l.x+l.w<=right+40).sort((a,b)=>a.y-b.y||a.x-b.x);
    const top=Math.min(...chosen.map(l=>l.y)), bottom=Math.max(...chosen.map(l=>l.y+l.h));
    return {text:chosen.map(l=>l.text).join('\n'),lines:chosen,rect:{x:Math.max(0,x-8),y:Math.max(0,top-8),w:Math.min(width-x+8,right-x+16),h:Math.min(height-top+8,bottom-top+16)},confidence: Math.min(.95,.5+best.lines.length*.025), strategy:'dense-column',mode,width,height};
  }
  const source=segments.length?segments.sort((a,b)=>a.y-b.y||a.x-b.x).map(l=>l.text):String(ocr.text??'').split(/\r?\n/);
  return {text:source.filter(l=>!noise(l)&&meaningful(l)>=4).join('\n'),lines:[],rect:null,confidence:.35,strategy:'filtered-text',mode,width,height};
}
const grams = text => {const s=norm(text);const out=[];for(let i=0;i<s.length-4;i++)out.push(s.slice(i,i+5));return out;};
export class ReadingMemory {
  constructor(){this.pages=[];}
  inspect(text) {
    const seen=new Set(this.pages.flatMap(p=>grams(p.text)));
    const lines=String(text).split(/\n+/).filter(Boolean);
    const fresh=lines.map(line=>{const g=grams(line);return !g.length||g.filter(s=>seen.has(s)).length/g.length<.72;});
    const chars=lines.reduce((sum,l,i)=>sum+(fresh[i]?norm(l).length:0),0);
    const total=norm(text).length;
    const repeated=this.pages.length>0 && (chars===0 || (total>120 && chars<Math.max(28,total*.12)));
    const picked=lines.filter((_,i)=>fresh[i]||fresh[i-1]||fresh[i+1]);
    return {repeated,text:picked.join('\n')||text,fresh_chars:chars};
  }
  remember(text){this.pages.unshift({text:String(text).slice(0,10000)});this.pages=this.pages.slice(0,30);}
}
export function focusFingerprint(fp,rect,width,height){
  if(!rect || typeof fp!=='string' || fp.length!==48*27*2)return null;
  const x0=Math.max(0,Math.floor(rect.x/width*48)),x1=Math.min(48,Math.ceil((rect.x+rect.w)/width*48));
  const y0=Math.max(0,Math.floor(rect.y/height*27)),y1=Math.min(27,Math.ceil((rect.y+rect.h)/height*27));
  let out='';for(let y=y0;y<y1;y++)out+=fp.slice((y*48+x0)*2,(y*48+x1)*2);return out;
}
