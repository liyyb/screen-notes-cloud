import { SystemAudioCapture, locateAudioCapture } from './audio.mjs';
import { createAsrProvider } from './asr.mjs';
export async function checkReadiness(core, { network = false, audio = false } = {}) {
  const checks = [];
  async function check(id, title, action, recovery) {
    const at = Date.now();
    try { checks.push({id,title,ok:true,detail:await action(),state:((id==='audio'&&!audio)||(['text','asr'].includes(id)&&!network))?'pending':'passed',ms:Date.now()-at,recovery}); }
    catch(e) { checks.push({id,title,ok:false,state:'failed',detail:e.message,ms:Date.now()-at,recovery}); }
  }
  await check('capture','屏幕读取',async()=>core._runSerial(async()=>{
    try { if(!core.win.ready)await core.win.start();const r=await core.win.request('snap');if(!r.width)throw Error('未能读取桌面');return `${r.width} × ${r.height}，截屏可用`; }
    finally {await core.win.request('clear').catch(()=>{});}
  }),'确认当前处于已解锁的 Windows 桌面，再重试');
  await check('ocr','文字识别',async()=>core._runSerial(async()=>{
    const r=await core.win.request('ocrtest',{},90000);if(!r.text?.trim())throw Error('未识别到测试文字');return `系统 OCR 可用（${r.language ?? '默认语言'}）`;
  }),'在 Windows 设置中安装中文语言的 OCR 功能后重试');
  await check('text','页面理解接口',async()=>{
    const cfg=core.settings.api_config;
    if(!cfg?.base_url||!cfg?.model||!cfg?.api_key)throw Error('请先填写地址、模型和密钥');
    if(!network)return '配置已填写；点击“测试接口连接”验证真实请求';
    const r=await core.provider.summarize({text:'这是一段连接测试文字，请概括测试目的。',intent:'companion',maxChars:200});
    if(r.parse_ok===false||r.raw==='')throw Error(core.provider.detail || '接口未返回有效回应');return '真实请求成功';
  },'打开设置核对文本接口地址、模型和密钥，保存后测试连接');
  const local = core.captionProvider() === 'LocalStreamingASR';
  await check('asr',local ? '本地中文字幕' : '字幕转写接口',async()=>{
    if (local) {
      if (!core.localAsrComponents.status().ready) throw Error('缺少本地中文流式组件');
      return '本地模型和运行组件已就绪，启动字幕时加载';
    }
    const p=createAsrProvider('OpenAiCompatibleASR',{root:core.root,...core.settings.asr_config});
    if(!p.ready)throw Error('请先填写语音识别接口配置');
    if(!network)return '配置已填写；点击“测试接口连接”验证真实请求';
    await p.transcribe(Buffer.alloc(16000),{sample_rate:16000,channels:1});return '接口已接受测试音频（静音）';
  },local ? '打开设置重新安装本地识别组件' : '打开设置核对 ASR 配置；文本模型不一定支持语音转写');
  if (local && checks.at(-1).ok) checks.at(-1).state = 'passed';
  await check('audio','字幕音源',async()=>{
    if(!audio)return '点击“测试音源”采集约一秒；不会保存或上传声音';
    if(core.captionSession)throw Error('请先停止当前字幕，再测试音源');
    const cap=new SystemAudioCapture(locateAudioCapture(core.root),{source:core.settings.audio_source ?? 'loopback'});
    try { await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('未收到音频，请检查默认设备和权限')),6000);cap.once('error',e=>{clearTimeout(timer);reject(e);});cap.once('data',()=>{clearTimeout(timer);resolve();});try{cap.start();}catch(e){clearTimeout(timer);reject(e);}});return '已收到音频数据；开启字幕后才会发送语音识别'; }
    finally {cap.stop();}
  },'系统声音需有可用的默认播放设备；麦克风需在 Windows 设置中允许桌面应用访问');
  return {checks,at:Date.now(),network_tested:network,audio_tested:audio};
}
