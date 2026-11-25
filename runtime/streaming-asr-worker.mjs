import {createRequire} from 'node:module';import path from 'node:path';
const [componentDir,modelDir]=process.argv.slice(2);
const require=createRequire(path.join(componentDir,'package.json'));
try {
  const sherpa=require('sherpa-onnx-node');
  const fs=require('node:fs');const model=fs.readdirSync(modelDir).find(n=>n.endsWith('.onnx'));
  const recognizer=new sherpa.OnlineRecognizer({featConfig:{sampleRate:16000,featureDim:80},modelConfig:{zipformer2Ctc:{model:path.join(modelDir,model)},tokens:path.join(modelDir,'tokens.txt'),numThreads:2,provider:'cpu',debug:0},enableEndpoint:true,rule1MinTrailingSilence:2.4,rule2MinTrailingSilence:0.6,rule3MinUtteranceLength:20,decodingMethod:'greedy_search'});
  let stream=recognizer.createStream(),clock=0,start=0,utterance=0,revision=0,last='';
  let trailingByte = Buffer.alloc(0);
  const publish=final=>{const text=recognizer.getResult(stream).text.trim();if(text&&(text!==last||final)){last=text;process.send({type:final?'final':'partial',utterance_id:`local:${utterance}`,revision:++revision,start_ms:start,end_ms:clock,text});}};
  process.on('message',message=>{
    try {
      if(message.type==='pcm'){
        const pcm = trailingByte.length ? Buffer.concat([trailingByte, message.pcm]) : message.pcm;
        const samples = new Float32Array(Math.floor(pcm.length / 2));
        trailingByte = pcm.length % 2 ? Buffer.from(pcm.subarray(-1)) : Buffer.alloc(0);
        for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
        if (!samples.length) { process.send({type:'ack',bytes:message.pcm.length}); return; }
        stream.acceptWaveform({sampleRate:16000,samples});clock+=samples.length/16;
        while(recognizer.isReady(stream))recognizer.decode(stream);
        publish(false);
        if(recognizer.isEndpoint(stream)){publish(true);recognizer.reset(stream);start=clock;utterance++;revision=0;last='';}
        process.send({type:'ack',bytes:message.pcm.length});
      }else if(message.type==='finish'){
        stream.acceptWaveform({sampleRate:16000,samples:new Float32Array(8000)});
        stream.inputFinished();
        while(recognizer.isReady(stream))recognizer.decode(stream);
        publish(true);
        stream = recognizer.createStream();
        clock = start = utterance = revision = 0;
        last = '';
        trailingByte = Buffer.alloc(0);
        process.send({type:'finished'});
      }
    }catch(e){process.send({type:'error',message:e.message});}
  });
  process.send({type:'ready'});
}catch(e){process.send?.({type:'error',message:e.message});process.exitCode=1;}
