import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {ScreenNotesCore} from '../runtime/core.mjs';
process.env.SCREEN_NOTES_DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'sn-companion-'));
const core=new ScreenNotesCore();core.setShellEnabled(true);let frame=0;
const text='产品设计讨论：减少用户操作步骤，提供即时反馈，并允许主动收藏有价值的页面理解。';
core.win.request=async cmd=>cmd==='foreground'?{process:'ChatGPT.exe',title:'屏幕笔记项目设计讨论 - ChatGPT'}:cmd==='snap'?{fingerprint:Array(1296).fill((++frame%3)*80),foreground:{process:'ChatGPT.exe',title:'屏幕笔记项目设计讨论 - ChatGPT'}}:cmd==='ocr'?{text}:{};
core.provider={status:()=>({state:'ready'}),stop(){},summarize:async input=>{assert.equal(input.intent,'companion');return {title:'让界面更省心',page_summary:'页面在讨论减少操作和提供反馈。',insight:'我觉得可以先明确用户每一步的预期。',summary:'页面在讨论减少操作和提供反馈。\n一点想法：我觉得可以先明确用户每一步的预期。',parse_ok:true,provider:'test'};}};
try {
 assert(!core.isSelfForeground({process:'ChatGPT.exe',title:'屏幕笔记项目设计讨论 - ChatGPT'}));
 assert(!core.isSelfForeground({process:'Code.exe',title:'屏幕笔记-cloud - Visual Studio Code'}));
 assert(core.isSelfForeground({process:'powershell.exe',title:'屏幕笔记 · 字幕'}));
 core.initialized=true;core.startAuto();
 const end=Date.now()+9000;while(!core.lastAutoInspire&&Date.now()<end)await new Promise(r=>setTimeout(r,100));
 assert(core.lastAutoInspire,'continuous animation must not indefinitely prevent OCR');
 assert.equal(core.db.count(),0);assert.equal(core.stats.summarize_calls,1);
 const events=(await core.dispatch('shell_poll')).commands.filter(x=>x.type==='auto_note');assert.equal(events.length,1);assert(events[0].summary.includes('想法'));
 assert.equal(core.shellState().companion.id,core.lastAutoInspire.id,'snapshot must recover a missed queue event');
 await core.stopAuto();
 const item=core.lastAutoInspire;await core.captureOnce('auto',{text});assert.equal(core.stats.summarize_calls,1,'same text should not spam replies');
 const a=await core.dispatch('collect_inspire',{id:item.id});const b=await core.dispatch('collect_inspire',{id:item.id});assert.equal(a.id,b.id);assert.equal(core.db.count(),1);
 console.log('COMPANION_OK real scheduler / changing pixels / project-title exclusion / transient output / bubble event / snapshot recovery / dedup / explicit collection');
} finally { core.shutdown(); }
