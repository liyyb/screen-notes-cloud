import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';
import {NoteStore} from '../runtime/db.mjs';import {CaptionSession} from '../runtime/asr.mjs';
import {CaptionController} from '../runtime/caption-controller.mjs';import {CaptionEvents} from '../runtime/caption-events.mjs';
const db=new NoteStore(fs.mkdtempSync(os.tmpdir()+'/sn-caption-queue-'));
const create=()=>{const s=new CaptionSession(db);s.start();return s;};
const segment=n=>({pcm:Buffer.alloc(6400),start_ms:n*200,end_ms:(n+1)*200});
try {
 const session=create(),resolvers=[];
 const controller=new CaptionController({session,provider:{name:'OpenAiCompatibleASR',transcribe:()=>new Promise(r=>resolvers.push(r))}});
 controller.enqueue(segment(0));controller.enqueue(segment(1));assert.equal(resolvers.length,2,'two in flight');
 resolvers[1]({text:'第二段'});await new Promise(r=>setImmediate(r));assert.equal(session.transcripts().length,0,'wait for earlier segment');
 resolvers[0]({text:'第一段'});await controller.drain();assert.deepEqual(session.transcripts().map(r=>r.text),['第一段','第二段']);
 session.addTranscript({start_ms:0,end_ms:200,text:'重复回包',is_final:true,utterance_key:'http:1'});assert.equal(session.transcripts().length,2);
 const recovered=create();let fail=true;
 const retry=new CaptionController({session:recovered,provider:{name:'OpenAiCompatibleASR',transcribe:async(_,m)=>{if(m.seq===0&&fail){const e=Error('unauthorized');e.httpStatus=401;throw e;}return {text:'段落'+m.seq};}}});
 retry.enqueue(segment(0));retry.enqueue(segment(1));await retry.drain();assert.equal(retry.failed.size,1);assert.equal(recovered.transcripts().length,1);
 fail=false;await retry.retryFailed();assert.equal(retry.failed.size,0);assert.deepEqual(recovered.transcripts().map(r=>r.text),['段落0','段落1']);assert.equal(db.db.prepare('SELECT count(*) AS n FROM caption_issues WHERE session_id=? AND resolved=0').get(recovered.id).n,0);
 const overflow=create();let paused=false;
 const limited=new CaptionController({session:overflow,provider:{name:'mock'},maxAudioMs:100,onPressure:()=>paused=true});limited.enqueue(segment(0));assert(paused);assert.equal(db.db.prepare('SELECT count(*) AS n FROM caption_issues WHERE session_id=?').get(overflow.id).n,1);
 const events=new CaptionEvents(4);const e={session_id:4,engine_epoch:1,utterance_id:'a',revision:1,text:'临时',type:'partial',start_ms:0};
 assert(events.accept(e));assert(events.accept({...e,revision:2,text:'完整的当前句'}));assert.equal(events.snapshot().display_text,'完整的当前句');assert(!events.accept(e));assert(events.accept({...e,revision:3,type:'final'}));assert(!events.accept({...e,revision:4,type:'final'}));assert(!events.accept({...e,session_id:5}));
 console.log('CAPTION_CONTROLLER_OK bounded concurrency / ordered commit / idempotent DB / retry gap / pressure / replaceable partial / old session rejection');
}finally{db.close();}
