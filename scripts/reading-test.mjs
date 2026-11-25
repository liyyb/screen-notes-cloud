import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {selectReadingContent,ReadingMemory,focusFingerprint} from '../runtime/reading.mjs';import {ScreenNotesCore} from '../runtime/core.mjs';
const body=['黄埔军校第四期人才众多，原因包括招生数量和学生素质的提高。','学生入学前的文化水平较高，也有来自各地的进步青年。','军校把政治教育和军事训练结合，重视革命精神的培养。','学生还参与东征和北伐，在实践中学习并成长。','军校历史也反映出中国近代军事教育的变化。'];
const layout=body.map((text,i)=>({words:[{text,x:1080,y:180+i*36,w:660,h:22}]}));
layout.push({words:[{text:'https://example.com/?token=xx&url=abc',x:200,y:40,w:1800,h:18}]});
for(let i=0;i<12;i++)layout.push({words:[{text:'推荐视频广告热门话题',x:700,y:180+i*70,w:220,h:20}]});
const ocr={text:'clutter',width:2560,height:1400,layout};const selected=selectReadingContent(ocr);
assert.equal(selected.strategy,'dense-column');assert(selected.rect.x>1000);assert.equal(selected.text,body.join('\n'));assert(!selected.text.includes('推荐'));
const memory=new ReadingMemory();assert(!memory.inspect(selected.text).repeated);memory.remember(selected.text);assert(memory.inspect(selected.text).repeated);
const other='全新的页面讨论语音识别、音频分段和字幕的视觉效果。';memory.remember(other);assert(memory.inspect(selected.text).repeated,'returning to an earlier article should not repeat');
const fresh='新出现的下文进一步介绍教师队伍建设，以及课程改革对人才成长的影响。';const novelty=memory.inspect(body.slice(2).join('\n')+'\n'+fresh);assert(!novelty.repeated);assert(novelty.text.includes(fresh));
const base='aa'.repeat(48*27);const pixels=Array(48*27).fill('aa');for(let y=0;y<27;y++)for(let x=0;x<18;x++)pixels[y*48+x]='11';
const side=pixels.join('');assert.equal(focusFingerprint(base,selected.rect,2560,1400),focusFingerprint(side,selected.rect,2560,1400),'sidebar animation should not change reading fingerprint');
process.env.SCREEN_NOTES_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'sn-reading-'));const core=new ScreenNotesCore();let fp=base;
core.win.request=async cmd=>cmd==='foreground'?{process:'browser.exe',title:'文章页'}:cmd==='snap'?{foreground:{process:'browser.exe',title:'文章页'},fingerprint:fp,width:2560,height:1400}:cmd==='ocr'?ocr:{};
core.provider={status:()=>({state:'ready'}),stop(){},summarize:async input=>{assert(input.text.includes('黄埔军校'));assert(!input.text.includes('推荐视频'));return {title:'人才培养',summary:'招生、教育与实践共同影响人才成长。',insight:'可以把课程与实践放在一起比较。',provider:'test',parse_ok:true};}};
try{
 const snap=await core.win.request('snap');await core.captureOnce('auto',{snap,with_image:false});assert.equal(core.stats.ocr_calls,1);
 core.initialized=true;core.settings.auto_enabled=true;fp=side;await core._autoTickInner();assert.equal(core.stats.ocr_calls,1,'unchanged reading region should skip OCR');
 await core.captureOnce('auto',{snap:{...snap,fingerprint:side},with_image:false});assert.equal(core.stats.summarize_calls,1,'already read body should skip model');
 assert.equal(core.db.count(),0);
 console.log('READING_OK dense column / browser chrome exclusion / returned-page memory / new paragraphs / sidebar animation / OCR skip / model skip');
}finally{await core.stopAuto();core.shutdown();}
