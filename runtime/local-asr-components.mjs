import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';import {Readable,Transform} from 'node:stream';

export const MODEL='sherpa-onnx-streaming-zipformer-small-ctc-zh-int8-2025-04-01';
const PACKAGES=[
 ['sherpa-onnx-node','1PSACfQgPXAD7ExwCv1QW09EXTjcNlpZKBqDY+jxSdIzlyOSq0M13SILBoUQUfeJqiTTXnqp6Ha9jjMUQ6efXg=='],
 ['sherpa-onnx-win-x64','7vwdAw9PGEb0JLSpK7UFxAdp1vabBHK9Nhw2jFRBWSFgtslUPHIB0T6syJfRgiUGyCeNW9fJvcFAk2F2u7hBEw==']
];
export class LocalAsrComponents {
  constructor(root){this.root=root;this.dir=process.env.SCREEN_NOTES_LOCAL_ASR_DIR||path.join(root,'components','local-asr');this.state='idle';this.percent=0;this.detail='本地识别组件未安装';}
  takeWarmWorker() {
    const worker = this.warmWorker;
    this.warmWorker = null;
    clearTimeout(this.warmTimeout);
    if (worker?.connected && worker.exitCode === null) return worker;
    worker?.kill();
    return null;
  }
  releaseWarmWorker(worker) {
    this.disposeWarmWorker();
    this.warmWorker = worker;
    this.warmTimeout = setTimeout(() => this.disposeWarmWorker(), 45000).unref();
  }
  disposeWarmWorker() {
    clearTimeout(this.warmTimeout);
    this.warmWorker?.kill();
    this.warmWorker = null;
  }
  status(){const model=path.join(this.dir,'model',MODEL);const ready=fs.existsSync(path.join(this.dir,'verified.json'))&&fs.existsSync(path.join(this.dir,'node_modules','sherpa-onnx-node','sherpa-onnx.js'))&&fs.existsSync(path.join(model,'tokens.txt'))&&fs.existsSync(path.join(model,'model.int8.onnx'))&&fs.existsSync(path.join(this.dir,'node_modules','sherpa-onnx-win-x64','sherpa-onnx.node'));
    return {ready,state:this.state==='installing'?'installing':ready?'ready':this.state,percent:this.percent,detail:this.state==='installing'||this.state==='error'?this.detail:ready?'中文流式组件已就绪，选择本地实时后保存设置即可使用':this.detail,model_dir:model,component_dir:this.dir};}
  install(force=false){if(this.status().ready&&!force)return this.status();if(this.promise)return this.status();this.state='installing';this.detail='准备下载，约数十 MB；请保持联网';this.promise=this.run().then(()=>{this.state='ready';this.percent=100;this.detail='安装完成';}).catch(e=>{this.state='error';this.detail='安装失败，可重试：'+e.message;}).finally(()=>this.promise=null);return this.status();}
  async run(){
    this.disposeWarmWorker();
    if(process.platform!=='win32'||process.arch!=='x64')throw Error('目前本地组件安装支持 Windows x64');
    const staging=this.dir+'.staging';fs.mkdirSync(staging,{recursive:true});
    const download=async(url,file,algorithm,expected,step)=>{
      if(expected&&fs.existsSync(file)){const cached=crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(algorithm==='sha512'?'base64':'hex');if(cached===expected)return cached;}
      let lastError;
      for(let attempt=0;attempt<4;attempt++) {
        try {
          let offset=fs.existsSync(file)?fs.statSync(file).size:0;
          const response=await fetch(url,{headers:offset?{Range:`bytes=${offset}-`}:{},signal:AbortSignal.timeout(600000)});
          if(!response.ok)throw Error('下载失败 HTTP '+response.status);
          if(response.status!==206)offset=0;
          let bytes=offset;const remaining=Number(response.headers.get('content-length'))||0;const total=offset+remaining;
          await pipeline(Readable.fromWeb(response.body),new Transform({transform:(chunk,_,cb)=>{bytes+=chunk.length;this.percent=Math.min(95,Math.round(step*30+(total?bytes/total:0)*28));this.detail=`下载本地识别组件 ${step+1}/3：${(bytes/1048576).toFixed(1)} MB`;cb(null,chunk);}}),fs.createWriteStream(file,{flags:offset?'a':'w'}));
          const actual=crypto.createHash(algorithm).update(fs.readFileSync(file)).digest(algorithm==='sha512'?'base64':'hex');
          if(expected&&actual!==expected){fs.truncateSync(file,0);throw Error('下载校验失败，将重新下载');}
          return actual;
        } catch(e){lastError=e;this.detail='下载中断，正在断点重试…';}
      }
      throw lastError;
    };
    const extract=async(file,destination)=>{fs.mkdirSync(destination,{recursive:true});
      const invoke=args=>new Promise((resolve,reject)=>{const p=spawn('tar',args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('exit',code=>code===0?resolve(out):reject(Error('解压失败：'+err.slice(-200))));});
      const listing=await invoke(['-tf',file]);if(String(listing).split(/\r?\n/).some(name=>/^[\/\\]|^[A-Za-z]:|(?:^|[\/\\])\.\.(?:[\/\\]|$)/.test(name)))throw Error('压缩包路径无效');
      await invoke(['-xf',file,'-C',destination]);
    };
    const records=[];
    for(let i=0;i<PACKAGES.length;i++){const [name,integrity]=PACKAGES[i];const archive=path.join(staging,name+'.tgz');await download(`https://registry.npmjs.org/${name}/-/${name}-2.0.1.tgz`,archive,'sha512',integrity,i);const temp=path.join(staging,name);await extract(archive,temp);const destination=path.join(staging,'node_modules',name);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.cpSync(path.join(temp,'package'),destination,{recursive:true});records.push({name,version:'2.0.1',integrity:'sha512-'+integrity});}
    const archive=path.join(staging,'model.tar.bz2');
    const digest=await download(`https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL}.tar.bz2`,archive,'sha256',MODEL_SHA256,2);
    await extract(archive,path.join(staging,'model'));
    fs.mkdirSync(this.dir,{recursive:true});fs.cpSync(path.join(staging,'node_modules'),path.join(this.dir,'node_modules'),{recursive:true});fs.cpSync(path.join(staging,'model'),path.join(this.dir,'model'),{recursive:true});
    fs.writeFileSync(path.join(this.dir,'来源与版本.txt'),`本地识别引擎：sherpa-onnx，Node接口及Windows二进制版本2.0.1。来源 https://github.com/k2-fsa/sherpa-onnx 。代码许可声明见各npm包LICENSE。模型：${MODEL}；来源 https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models ，模型文档 https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-ctc/zipformer-ctc-models.html 。本地组件默认仅支持中文，不保证英文识别。`);
    fs.writeFileSync(path.join(this.dir,'verified.json'),JSON.stringify({model:MODEL,sha256:digest,packages:records,at:new Date().toISOString()},null,2));
  }
}
// Pinned upstream archive checksum, verified during the integration test.
const MODEL_SHA256 = 'b3b309f7ce4a737195fcc6963ea19b0653a7d3401580af5ae0d3e284cbb71f0b';
