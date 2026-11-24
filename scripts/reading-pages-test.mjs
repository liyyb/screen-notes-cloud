import assert from 'node:assert/strict';
import {fixtures} from './reading-fixtures.mjs';import {selectReadingContent} from '../runtime/reading.mjs';
for(const f of fixtures()) {const r=selectReadingContent(f.ocr,f.options);assert.equal(r.strategy,f.strategy,f.name);assert(r.text.includes(f.included),f.name);assert(!r.text.includes(f.excluded),f.name);if(f.order)assert(r.text.indexOf(f.order[0])<r.text.indexOf(f.order[1]),f.name);assert(r.rect&&r.confidence>=.55);}
const f=fixtures()[0],r=selectReadingContent(f.ocr,{rect:{x:0,y:150,w:280,h:700}});assert.equal(r.strategy,'user-region');assert(r.text.includes('推荐阅读'));assert(!r.text.includes('实战训练'));
console.log('READING_PAGES_OK 20 labeled synthetic layouts / column order / browser chrome / sidebars / manual correction');
