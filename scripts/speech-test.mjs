import assert from 'node:assert/strict';
import {SpeechSegmenter, normalizeTranscript, joinTranscript, polishTranscript} from '../runtime/speech.mjs';
const tone = ms => { const b=Buffer.alloc(ms*32); for(let i=0;i<b.length;i+=2)b.writeInt16LE(Math.round(Math.sin(i/2/16000*2*Math.PI*440)*5000),i);return b; };
const segments=[];const s=new SpeechSegmenter(x=>segments.push(x));
s.push(Buffer.alloc(32000));assert.equal(segments.length,0,'静音不可发送请求');
s.push(tone(900));s.push(Buffer.alloc(320*32));assert.equal(segments.length,1,'停顿应立即分段');assert.equal(segments[0].start_ms,840);assert(segments[0].end_ms<=2220);
s.push(tone(6500));s.finish();assert(segments.every(x=>x.pcm.length<=3200*32),'连续讲话片段不能无限增长');
const quickStart = [];
const adaptive = new SpeechSegmenter(x => quickStart.push(x), { firstMaxMs:1200, maxMs:2200 });
adaptive.push(tone(3500));
assert.deepEqual(quickStart.map(x => x.end_ms-x.start_ms), [1200,2200]);
assert.equal(normalizeTranscript('屏 幕 笔 记 ， 测 试 。'),'屏幕笔记， 测试。');
assert.equal(joinTranscript([{text:'今天讨论'},{text:'发布计划。'},{text:'请保存。'}]),'今天讨论发布计划。\n请保存。');
assert.equal(joinTranscript([{text:'Screen notes'},{text:'functional test.'}]),'Screen notes functional test.');
assert.equal(joinTranscript([{text:'会议结束以后。'},{text:'把记录保存。'}]),'会议结束以后，把记录保存。');
const originalFetch=globalThis.fetch;
try {
 globalThis.fetch=async()=>({ok:true,json:async()=>({choices:[{message:{content:'今天，讨论发布计划。'}}]})});
 assert.equal(await polishTranscript('今天讨论发布计划',{base_url:'https://example.com/v1',api_key:'test',model:'test'}),'今天，讨论发布计划。');
 globalThis.fetch=async()=>({ok:true,json:async()=>({choices:[{message:{content:'今天讨论删除所有笔记。'}}]})});
 assert.equal(await polishTranscript('今天讨论发布计划',{base_url:'https://example.com/v1',api_key:'test',model:'test'}),'今天讨论发布计划','改写原文必须被拒绝');
} finally {globalThis.fetch=originalFetch;}
console.log('SPEECH_PIPELINE_OK silence / pause / bounds / joining / punctuation / rewrite rejection');
