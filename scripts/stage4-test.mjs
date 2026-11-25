import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {ScreenNotesCore} from '../runtime/core.mjs';import {fixtures} from './reading-fixtures.mjs';
process.env.SCREEN_NOTES_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'sn-stage4-'));
const c=new ScreenNotesCore();c.setShellEnabled(true);
let f=fixtures()[0],bounds={x:0,y:0,w:1600,h:1000},fg={process:'test.exe',title:'文章',bounds},calls=0;
c.win.ready=true;c.win.start=async()=>{};c.win.request=async(cmd)=>cmd==='foreground'?fg:cmd==='snap'?{width:f.ocr.width,height:f.ocr.height,foreground:fg}:cmd==='ocr'?f.ocr:cmd==='ocrRegion'?{text:''}:cmd==='ocrtest'?{text:'测试识别',language:'zh'}:{};
c.provider={status:()=>({state:'ready'}),stop(){},summarize:async()=>({raw:'ok',parse_ok:true,summary:'页面在讨论教育与实践的关系。'+(++calls),provider:'test'})};
try {
 await c.captureOnce('auto',{forceReply:true});assert(c.lastReadingCandidate.rect);
 await c.dispatch('request_reading_region');assert(c._selectingReadingRegion);await c.dispatch('cancel_reading_region');assert(!c._selectingReadingRegion);
 await c.dispatch('set_reading_region',{rect:{x:0,y:150,w:280,h:650}});assert(c.userReadingRegion);
 const reply=await c.captureOnce('auto',{forceReply:true});assert(reply.ocr_text.includes('推荐阅读'));assert(!reply.ocr_text.includes('实战训练'));assert.equal(reply.reading_focus.strategy,'user-region');
 bounds={x:40,y:0,w:1550,h:1000};fg={...fg,bounds};await c.captureOnce('auto',{forceReply:true});assert.equal(c.userReadingRegion,null,'moved window invalidates region');
 await assert.rejects(c.dispatch('set_reading_region',{rect:{x:-1,y:0,w:100,h:100}}));
 await c.dispatch('show_reading_region');assert(c.shellQueue.some(x=>x.type==='highlight_reading_region'));
 c.settings.api_config.timeout_ms=45000;c.settings.asr_config.timeout_ms=60000;
 const asrKeys=structuredClone(c.settings.asr_config);const keys=structuredClone(c.settings.api_config);await c.dispatch('update_settings',{settings:{audio_source:'microphone',reading_mode:'document',companion_pace:'quiet'}});assert.deepEqual(c.settings.api_config,keys);assert.deepEqual(c.settings.asr_config,asrKeys);
 const before=c.db.count();const check=await c.dispatch('check_readiness');assert.equal(check.checks.length,5);assert.equal(check.checks.find(x=>x.id==='audio').state,'pending');assert.equal(c.db.count(),before);
 await c.dispatch('caption_style_preset',{name:'large'});assert.equal(c.settings.caption_style.font_size,42);await c.dispatch('caption_style_preset',{name:'default'});assert.equal(c.settings.caption_style.font_size,28);
 await c.dispatch('complete_onboarding');assert(c.settings.onboarding_done);
 console.log('STAGE4_API_OK manual region / cancellation / geometry invalidation / highlight queue / configuration preservation / readiness / presets / onboarding');
} finally {c.shutdown();}
