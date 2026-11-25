/** Lightweight PCM endpointing for cloud ASR. No model or audio file required. */
export class SpeechSegmenter {
  constructor(onSegment, { threshold = 0.006, pauseMs = 320, maxMs = 3200, firstMaxMs = maxMs, firstPauseAfterMs = firstMaxMs } = {}) {
    Object.assign(this, { onSegment, threshold, pauseMs, maxMs, firstMaxMs, firstPauseAfterMs });
    this.isFirst = true;
    this.pending = Buffer.alloc(0); this.frames = []; this.pre = []; this.clock = 0; this.start = 0; this.silence = 0;
  }
  push(chunk) {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= 640) {
      const frame = Buffer.from(this.pending.subarray(0, 640)); this.pending = this.pending.subarray(640);
      let sum = 0; for (let i = 0; i < 640; i += 2) sum += (frame.readInt16LE(i) / 32768) ** 2;
      const voiced = Math.sqrt(sum / 320) >= this.threshold;
      if (!this.frames.length && voiced) { this.start = this.clock - this.pre.length * 20; this.frames.push(...this.pre); this.pre = []; }
      if (this.frames.length || voiced) {
        this.frames.push(frame); this.silence = voiced ? 0 : this.silence + 20;
        const duration = this.frames.length * 20;
        const firstPause = this.isFirst && duration >= this.firstPauseAfterMs && this.silence >= 80;
        if (firstPause || this.silence >= this.pauseMs || duration >= (this.isFirst ? this.firstMaxMs : this.maxMs)) this.flush();
      } else { this.pre.push(frame); if (this.pre.length > 8) this.pre.shift(); }
      this.clock += 20;
    }
  }
  flush() {
    if (this.frames.length) {
      const pcm = Buffer.concat(this.frames);
      this.isFirst = false;
      this.onSegment({ pcm, start_ms: this.start, end_ms: this.start + this.frames.length * 20 });
      this.frames = []; this.silence = 0;
    }
  }
  finish() { if (this.pending.length && this.frames.length) this.frames.push(this.pending); this.pending = Buffer.alloc(0); this.flush(); }
}

export function normalizeTranscript(text) {
  return String(text ?? '').replace(/\s+/g, ' ').replace(/([\u3400-\u9fff]) +(?=[\u3400-\u9fff])/g, '$1').replace(/ +([，。！？；：,.!?;:])/g, '$1').trim();
}
export function joinTranscript(rows) {
  let text = '';
  for (const row of rows) {
    const part = normalizeTranscript(row.text); if (!part) continue;
    if (text && /(?:以后|之前|之后|时候|的话|因此|所以|但是|然后)。$/.test(text)) text = text.slice(0, -1) + '，';
    else if (text && /[。！？.!?]$/.test(text)) text += '\n';
    else if (text && /[a-z0-9]$/i.test(text) && /^[a-z0-9]/i.test(part)) text += ' ';
    text += part;
  }
  return text;
}

/** Restore punctuation only. Reject any rewrite of the spoken words. */
export async function polishTranscript(text, config) {
  if (!config?.api_key || !config?.base_url || text.length > 12000) return text;
  const identity = s => s.replace(/[\p{P}\p{Z}\s]/gu, '');
  const parts = [];
  for (let i = 0; i < text.length; i += 1600) {
    const input = text.slice(i, i + 1600);
    const body = { model: config.model, messages: [{ role: 'system', content: '你是逐字转写标点整理器。原文由短音频拼接，片段末尾句号和换行可能是错误的。请按完整语义重新断句，把不完整分句末尾的句号改成逗号，例如“会议结束以后。把记录保存。”应为“会议结束以后，把记录保存。”。只添加或调整标点、空格和段落换行。必须保留全部原始文字和顺序，不可总结、删减、纠错或添加任何文字。只输出整理后的原文，不加说明。' }, { role: 'user', content: input }], max_tokens: 4096, temperature: 0, stream: false };
    if (new URL(config.base_url).hostname === 'api.deepseek.com') body.thinking = { type: 'disabled' };
    const r = await fetch(config.base_url.replace(/\/+$/, '') + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.api_key }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error('标点整理暂不可用，HTTP ' + r.status);
    const result = (await r.json())?.choices?.[0]?.message?.content?.trim();
    parts.push(result && identity(result) === identity(input) ? result : input);
  }
  return parts.join('');
}
