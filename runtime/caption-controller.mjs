import { CaptionEvents } from './caption-events.mjs';
import { normalizeTranscript } from './speech.mjs';

/** Bounded HTTP queue with ordered commits; recognizer adapters remain interchangeable. */
export class CaptionController {
  constructor({session,provider,concurrency=2,maxAudioMs=120000,onIssue=()=>{},onPressure=()=>{},now=()=>performance.now()}) {
    Object.assign(this,{session,provider,onIssue,onPressure,now,maxAudioMs});
    this.concurrency=provider.name==='OpenAiCompatibleASR'?Math.max(1,Math.min(2,concurrency)):1;
    this.events=new CaptionEvents(session.id);this.next=0;this.commitNext=0;
    this.pending=[];this.running=0;this.retainedMs=0;this.completed=new Map();
    this.failed=new Map();this.waiters=[];this.accepting=true;this.cancelled=false;
    this.lostSegments=0;this.abort=new AbortController();this.samples=[];this.queuedAudioMs=0;this.requestCount=0;
  }
  enqueue(segment) {
    if(!this.accepting||this.cancelled)return;
    const job={...segment,seq:this.next++,key:`http:${this.next}`,enqueued:this.now(),attempts:0};
    job.duration=Math.max(0,job.end_ms-job.start_ms);
    if(this.retainedMs+job.duration>this.maxAudioMs) {
      this.accepting=false;this.lostSegments++;this.issue(job,'待识别音频达到上限，采集已暂停；这一段未能处理',false);
      this.completed.set(job.seq,{job,error:true});this.commit();this.onPressure();return;
    }
    this.retainedMs+=job.duration;this.queuedAudioMs+=job.duration;this.pending.push(job);this.pump();
  }
  issue(job,message,retryable) {
    this.session.db.db.prepare(`INSERT INTO caption_issues(session_id,utterance_key,start_ms,end_ms,message,resolved)
      VALUES(?,?,?,?,?,0) ON CONFLICT(session_id,utterance_key) DO UPDATE SET message=excluded.message,resolved=0`)
      .run(this.session.id,job.key,job.start_ms,job.end_ms,String(message).slice(0,500));
    this.onIssue({start_ms:job.start_ms,end_ms:job.end_ms,message,retryable});
  }
  pump() {
    while(!this.cancelled&&this.running<this.concurrency&&this.pending.length) {
      const job=this.pending.shift();this.running++;this.run(job).finally(()=>{this.running--;this.pump();this.settle();});
    }
    this.settle();
  }
  async run(job) {
    const started=this.now();let result,error;
    this.firstSubmitAt ??= Date.now();
    for(let attempt=0;attempt<2;attempt++) {
      this.requestCount++;
      try { result=await this.provider.transcribe(job.pcm,{...job,signal:this.abort.signal});error=null;break; }
      catch(e){error=e;const code=e.httpStatus;const recoverable=code===429||code>=500||(!code&&/timeout|fetch|network|网络|超时/i.test(e.message));
        if(code===429)this.concurrency=1;
        if(!recoverable||attempt===1||this.cancelled)break;
        await new Promise(resolve=>{const done=()=>{clearTimeout(timer);this.abort.signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,350);this.abort.signal.addEventListener('abort',done,{once:true});});
      }
    }
    if(this.cancelled)return;
    this.queuedAudioMs -= job.duration;
    this.samples.push({seq:job.seq,audio_ms:job.duration,queue_ms:started-job.enqueued,request_ms:this.now()-started});this.samples=this.samples.slice(-120);
    if(error){this.failed.set(job.seq,job);this.issue(job,error.message,true);}
    else {this.failed.delete(job.seq);this.retainedMs-=job.duration;job.pcm=null;
      this.session.db.db.prepare('UPDATE caption_issues SET resolved=1 WHERE session_id=? AND utterance_key=?').run(this.session.id,job.key);}
    if(job.seq<this.commitNext){if(!error)this.publish(job,result);}
    else {this.completed.set(job.seq,{job,result,error});this.commit();}
  }
  commit() {
    while(this.completed.has(this.commitNext)) {
      const r=this.completed.get(this.commitNext);this.completed.delete(this.commitNext++);
      if(!r.error)this.publish(r.job,r.result);
    }
  }
  publish(job,result) {
    const text=normalizeTranscript(result?.text);
    if(!text)return;
    const event={type:'final',session_id:this.session.id,engine_epoch:1,utterance_id:job.key,revision:1,start_ms:job.start_ms,end_ms:job.end_ms,text};
    this.session.addTranscript({...event,is_final:true,selected:false,utterance_key:job.key});
    this.events.accept(event);
  }
  async retryFailed() {
    if(this.cancelled)throw Error('音频已释放，无法重试');
    if(this.running||this.pending.length)throw Error('正在识别，请稍后重试失败片段');
    for(const job of this.failed.values()){job.enqueued=this.now();this.queuedAudioMs+=job.duration;this.pending.push(job);}
    this.pump();await this.drain();
  }
  drain(){return this.running||this.pending.length?new Promise(r=>this.waiters.push(r)):Promise.resolve();}
  settle(){if(!this.running&&!this.pending.length){for(const resolve of this.waiters.splice(0))resolve();}}
  waitingAudioMs() { return this.queuedAudioMs; }
  snapshot(){return {...this.events.snapshot(),queued_segments:this.pending.length+this.running,
    waiting_audio_ms:this.waitingAudioMs(),failed_segments:this.failed.size+this.lostSegments,
    processing:this.running>0,paused:!this.accepting,metrics:this.samples.slice(-20)};}
  cancel(){this.cancelled=true;this.accepting=false;this.abort.abort();this.pending=[];this.failed.clear();this.retainedMs=0;this.queuedAudioMs=0;this.settle();}
}
