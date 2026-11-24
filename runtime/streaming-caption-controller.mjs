import {fork} from 'node:child_process';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {CaptionEvents} from './caption-events.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
export class StreamingCaptionController {
  constructor({session,components,onIssue=()=>{},onPressure=()=>{}}){Object.assign(this,{session,components,onIssue,onPressure});this.events=new CaptionEvents(session.id);this.failed=new Map();this.buffered=0;this.cancelled=false;this.finished=false;this.started=Date.now();this.audioMs=0;this.metrics=[];}
  async start(){
    const cfg=this.components.status();if(!cfg.ready)throw Error('请先在设置中安装本地识别组件');
    const warmWorker = this.components.takeWarmWorker();
    this.proc=warmWorker ?? fork(path.join(here,'streaming-asr-worker.mjs'),[cfg.component_dir,cfg.model_dir],{windowsHide:true,execArgv:['--no-warnings'],serialization:'advanced',stdio:['ignore','pipe','pipe','ipc']});
    this.proc.stderr.on('data',d=>{this.workerError=(this.workerError??'').slice(-1000)+d.toString();});this.proc.stdout.resume();
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('本地引擎加载超时')),30000);
      this.proc.on('message',event=>{
        if(this.cancelled)return;
        if(event.type==='ready'){clearTimeout(timer);resolve();}
        else if(event.type==='error'){clearTimeout(timer);reject(Error(event.message));this.issue(event.message);}
        else if(event.type==='ack')this.buffered=Math.max(0,this.buffered-event.bytes);
        else if(event.type==='finished'){
          this.finished=true;
          const worker = this.proc;
          worker.removeAllListeners('message');
          worker.removeAllListeners('exit');
          worker.removeAllListeners('error');
          worker.stderr.removeAllListeners('data');
          worker.stderr.resume();
          worker.on('error', () => {});
          this.proc = null;
          this.components.releaseWarmWorker(worker);
          this.resolveFinish?.();
        }
        else if(['partial','final'].includes(event.type)){
          const e={...event,session_id:this.session.id,engine_epoch:1};
          if(this.events.accept(e)&&event.type==='final')this.session.addTranscript({...event,is_final:true,selected:false,utterance_key:event.utterance_id});
        }
      });
      this.proc.on('error',e=>{clearTimeout(timer);reject(e);this.issue(e.message);});
      this.proc.on('exit',code=>{clearTimeout(timer);if(!this.cancelled&&!this.finished){reject(Error('本地引擎退出 '+code+' '+(this.workerError??'').slice(-500)));this.issue('本地引擎已退出，请停止字幕后重新启动');this.resolveFinish?.();}});
      if (warmWorker) { clearTimeout(timer); resolve(); }
    });
  }
  issue(message){if(this.cancelled||this.lastIssue===message)return;this.lastIssue=message;
    this.session.db.db.prepare('INSERT OR REPLACE INTO caption_issues(session_id,utterance_key,start_ms,end_ms,message,resolved) VALUES(?,?,?,?,?,0)').run(this.session.id,'local-engine',0,this.audioMs,message);
    this.onIssue({message});this.onPressure();}
  push(pcm){if(this.cancelled||this.finished||this.lastIssue)return;this.buffered+=pcm.length;this.audioMs+=pcm.length/32;
    if(this.buffered>32000*120){this.issue('本地识别跟不上输入，采集已暂停');return;}
    this.proc.send({type:'pcm',pcm},e=>{if(e)this.issue(e.message);});}
  waitingAudioMs(){return this.buffered/32;}
  drain(){if(this.finished||this.lastIssue)return Promise.resolve();if(this.finishPromise)return this.finishPromise;
    this.finishPromise=new Promise(resolve=>{this.resolveFinish=()=>{clearTimeout(this.finishTimer);resolve();};this.finishTimer=setTimeout(()=>{this.issue('本地字幕收尾超时，部分音频可能未处理');this.resolveFinish();},15000);this.proc.send({type:'finish'},e=>{if(e){this.issue(e.message);this.resolveFinish();}});});return this.finishPromise;}
  snapshot(){return {...this.events.snapshot(),queued_segments:this.buffered?1:0,waiting_audio_ms:this.buffered/32,failed_segments:this.lastIssue?1:0,paused:!!this.lastIssue,metrics:this.metrics};}
  cancel(){this.cancelled=true;clearTimeout(this.finishTimer);this.resolveFinish?.();this.proc?.kill();this.failed.clear();this.buffered=0;}
  async retryFailed(){throw Error('本地识别无法重放已释放音频；请保存已识别内容后重新启动');}
}
