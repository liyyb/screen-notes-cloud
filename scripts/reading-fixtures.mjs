import {selectReadingContent} from '../runtime/reading.mjs';
export function fixtures(){
 const pages=[];
 const row=(text,x,y,w=500)=>({words:[{text,x,y,w,h:22}]});
 for(let variant=0;variant<5;variant++){
  const width=1600+variant*160,height=1000+variant*40;
  const sidebar=Array.from({length:7},(_,i)=>row('推荐阅读广告短文链接和热门消息列表',30,200+i*60,210));
  const body=Array.from({length:9},(_,i)=>row(`正文第${i+1}段解释黄埔军校的政治教育与实战训练怎样影响人才培养，并提供历史背景。`,width*.4,180+i*50,width*.4));
  pages.push({name:`文章与推荐栏-${variant}`,ocr:{width,height,layout:[row('https://example.com/?token=abcd',40,40,1000),...sidebar,...body]},options:{title:'教育历史文章'},strategy:'dense-column',included:'实战训练',excluded:'推荐阅读'});
  const left=Array.from({length:7},(_,i)=>row(`左栏第${i+1}段：这篇论文首先讨论实验方法与数据采集，提供完整条件和实验结果分析。`,width*.18,190+i*60,width*.3));
  const right=Array.from({length:7},(_,i)=>row(`右栏第${i+1}段：论文继续讨论研究结论与方法局限，说明未来还需要进行哪些实验。`,width*.55,190+i*60,width*.3));
  pages.push({name:`双栏论文-${variant}`,ocr:{width,height,layout:[...left,...right]},options:{title:'research.pdf'},strategy:'document-columns',included:'研究结论',excluded:'不存在的导航',order:['左栏第7','右栏第1']});
  const chat=Array.from({length:8},(_,i)=>row(`成员${i+1}：我们正在讨论下周交付安排，请先确认需求范围，并把反馈发送到本次讨论。`,width*(i%2?.48:.32),170+i*65,width*.36));
  pages.push({name:`聊天与联系人-${variant}`,ocr:{width,height,layout:[...sidebar,...chat]},options:{title:'项目群 - 微信'},strategy:'conversation',included:'下周交付',excluded:'推荐阅读'});
  const code=Array.from({length:10},(_,i)=>row(`const response${i} = await readPage(input); // process current viewport`,width*.25+(i%3)*20,160+i*45,width*.6));
  pages.push({name:`代码与目录-${variant}`,ocr:{width,height,layout:[...sidebar,...code]},options:{title:'reading.mjs - Visual Studio Code'},strategy:'code-editor',included:'readPage',excluded:'推荐阅读'});
 }
 return pages;
}
