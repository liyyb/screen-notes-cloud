/**
 * ASR 提供方抽象 + 字幕会话管理（Node 端）。
 *
 * TranscriptProvider：
 *   LocalWhisper   — 本地 whisper.cpp（需按需下载模型，未下载时不可用）
 *   WindowsSpeech  — WinRT 语音识别（零体积兜底，能力有限）
 *   OpenAiCompatibleASR — 云端音频转写 API
 *   MockASR        — 确定性假转写（仅测试用，不进入生产 UI）
 *
 * 音频本身不落盘；字幕 final 文本在会话期间写入 transcripts 待处理区。
 */
import { ContractError } from '../contracts/errors.mjs';
import { ASR_PROVIDERS } from '../contracts/brief.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export class MockAsrProvider {
  constructor() { this.name = 'MockASR'; }
  status() { return { name: this.name, state: 'ready', detail: '测试用确定性转写' }; }
  async transcribe(pcm, meta = {}) {
    // 确定性：按时间片返回固定文本，供端到端测试。
    const seq = meta.seq ?? 0;
    return {
      text: `测试字幕片段 ${seq + 1}`,
      final: true,
      start_ms: meta.start_ms ?? 0,
      end_ms: meta.end_ms ?? (meta.start_ms ?? 0) + 1000,
      provider: this.name
    };
  }
  stop() {}
}

/** PCM（16k mono s16le）→ WAV Buffer。ASR 各实现共用。 */
export function pcmToWav(pcm, sampleRate = 16000, channels = 1, bitDepth = 16) {
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);                 // fmt chunk size
  header.writeUInt16LE(1, 20);                  // PCM
  header.writeUInt16LE(channels, 22);           // channels
  header.writeUInt32LE(sampleRate, 24);         // sample rate
  header.writeUInt32LE(byteRate, 28);           // byte rate
  header.writeUInt16LE(blockAlign, 32);         // block align
  header.writeUInt16LE(bitDepth, 34);           // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export class LocalWhisperProvider {
  /**
   * 本地 whisper.cpp 转写。
   *
   * @param {object} opts
   *   - modelPath   ggml-base.bin 等模型绝对路径
   *   - binDir      whisper-cli.exe 所在目录（含依赖 DLL）
   *   - language    目标语言（'auto' | 'zh' | 'en' ...），默认 'zh'
   *
   * 重要：whisper-cli.exe 在 Windows 下遇到含非 ASCII（中文）的模型/音频路径会
   * 静默失败（进程 exit 127）。因此模型会被复制到系统临时目录（纯 ASCII）缓存，
   * 音频每次写临时 WAV（转写后即删，音频不落盘）。
   */
  constructor(opts = {}) {
    this.name = 'LocalWhisper';
    this.modelPath = opts.modelPath ?? '';
    this.binDir = opts.binDir ?? '';
    this.language = opts.language ?? 'zh';
    this.state = 'stopped';
    this.detail = '未就绪';
    this._tmpModel = null;
  }
  status() {
    return { name: this.name, state: this.state, detail: this.detail, model_path: this.modelPath };
  }

  get _cli() {
    return path.join(this.binDir, 'whisper-cli.exe');
  }

  get ready() {
    return !!this.modelPath && !!this.binDir && fs.existsSync(this.modelPath) && fs.existsSync(this._cli);
  }

  /** 把模型复制到纯 ASCII 的临时目录（幂等，进程生命周期内只拷一次）。 */
  _ensureTmpModel() {
    if (this._tmpModel && fs.existsSync(this._tmpModel)) return this._tmpModel;
    const tmpDir = os.tmpdir();
    const base = path.basename(this.modelPath);
    const dest = path.join(tmpDir, `screen_notes_whisper_${crypto.randomUUID().slice(0, 8)}_${base}`);
    fs.copyFileSync(this.modelPath, dest);
    this._tmpModel = dest;
    return dest;
  }

  /**
   * 将 PCM（16k mono s16le）转写为文本。
   * @param {Buffer} pcm 原始 PCM 样本
   * @param {object} meta { start_ms, end_ms, seq } 时间片元信息（可选）
   * @returns {{text:string, final:boolean, start_ms:number, end_ms:number, provider:string}}
   */
  async transcribe(pcm, meta = {}) {
    if (!this.ready) {
      throw new ContractError('ASR_NOT_READY', '本地 Whisper 模型或二进制缺失，请先运行 scripts/fetch_whisper.mjs 下载');
    }
    if (!Buffer.isBuffer(pcm) || pcm.length < 320) {
      // 少于 20ms 音频，无有效内容。
      return { text: '', final: false, start_ms: meta.start_ms ?? 0, end_ms: meta.end_ms ?? 0, provider: this.name };
    }

    const model = this._ensureTmpModel();
    const wavPath = this._writeWav(pcm);
    this.state = 'busy';

    try {
      const args = [
        '-m', model,
        '-f', wavPath,
        '-l', this.language,
        '-nt',            // 不打印时间戳
        '-np',            // 只打印结果
        '-t', String(4)   // 线程数
      ];
      const result = await this._spawn(args);
      const text = result.stdout.trim();
      this.state = 'ready';
      this.detail = '就绪';
      return {
        text,
        final: text.length > 0,
        start_ms: meta.start_ms ?? 0,
        end_ms: meta.end_ms ?? (meta.start_ms ?? 0) + (pcm.length / 2 / 16000) * 1000,
        provider: this.name
      };
    } catch (e) {
      this.state = 'error';
      this.detail = `转写失败：${e.message}`;
      throw new ContractError('ASR_TRANSCRIBE_FAILED', `whisper 转写失败：${e.message}`);
    } finally {
      try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
    }
  }

  /** 写临时 WAV（16k mono 16-bit）。 */
  _writeWav(pcm) {
    const wavPath = path.join(os.tmpdir(), `screen_notes_asr_${crypto.randomUUID().slice(0, 8)}.wav`);
    fs.writeFileSync(wavPath, pcmToWav(pcm));
    return wavPath;
  }

  /** spawn whisper-cli 并收集 stdout/stderr。 */
  _spawn(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(this._cli, args, {
        cwd: this.binDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (e) => reject(e));
      child.on('close', (code) => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`whisper-cli exit ${code}${stderr ? `: ${stderr.slice(-300)}` : ''}`));
      });
    });
  }

  stop() {
    this.state = 'stopped';
    if (this._tmpModel) {
      try { fs.unlinkSync(this._tmpModel); } catch { /* ignore */ }
      this._tmpModel = null;
    }
  }
}

export class OpenAiCompatibleAsrProvider {
  /**
   * 云端语音转写（OpenAI 兼容 /audio/transcriptions）。
   * 支持 OpenAI / Groq / SiliconFlow / 通义等任何实现 POST /audio/transcriptions 的服务。
   * 典型配置：
   *   - SiliconFlow: base_url https://api.siliconflow.cn/v1, model FunAudioLLM/SenseVoiceSmall
   *   - OpenAI:      base_url https://api.openai.com/v1,        model whisper-1
   *   - Groq:        base_url https://api.groq.com/openai/v1,    model whisper-large-v3-turbo
   */
  constructor(config = {}) {
    this.name = 'OpenAiCompatibleASR';
    this.config = {
      base_url: (config.base_url ?? '').replace(/\/+$/, ''),
      api_key: config.api_key ?? '',
      model: config.model ?? 'whisper-1',
      language: config.language ?? 'zh',
      timeout_ms: config.timeout_ms ?? 30000
    };
    this.state = 'stopped';
    this.detail = '未启用';
    this.lastMs = null;
  }
  setKey(key) { this.config.api_key = key ?? ''; }
  status() {
    return { name: this.name, state: this.state, detail: this.detail, model_path: '', api_supported: true };
  }

  get ready() {
    return !!this.config.base_url && !!this.config.api_key && !!this.config.model;
  }

  /**
   * 将 PCM（16k mono s16le）经云端转写为文本。
   * @param {Buffer} pcm 原始 PCM 样本
   * @param {object} meta { start_ms, end_ms, seq }
   */
  async transcribe(pcm, meta = {}) {
    if (!this.ready) {
      throw new ContractError('PROVIDER_UNAUTHORIZED', '音频 API 未配置（需 base_url + api_key + model）');
    }
    if (!Buffer.isBuffer(pcm) || pcm.length < 320) {
      return { text: '', final: false, start_ms: meta.start_ms ?? 0, end_ms: meta.end_ms ?? 0, provider: this.name };
    }

    const wav = pcmToWav(pcm);
    const t0 = Date.now();
    this.state = 'busy';
    this.detail = '云端转写中…';

    // 手工构造 multipart/form-data（避免依赖第三方 form-data 包）。
    const boundary = `----ScreenNotes${crypto.randomUUID().replace(/-/g, '')}`;
    const parts = [];
    const field = (name, value) => {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      ));
    };
    const file = (name, filename, buf, contentType) => {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`
      ));
      parts.push(buf);
      parts.push(Buffer.from('\r\n'));
    };
    const deepseek = new URL(this.config.base_url).hostname === 'api.deepseek.com';
    if (!deepseek) field('model', this.config.model);
    if (!deepseek && this.config.language && this.config.language !== 'auto') field('language', this.config.language);
    if (!deepseek) field('response_format', 'json');
    file('file', 'audio.wav', wav, 'audio/wav');
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    try {
      const r = await fetch(`${this.config.base_url}/${deepseek ? 'tools/asr' : 'audio/transcriptions'}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.api_key}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        },
        body,
        signal: meta.signal ? AbortSignal.any([meta.signal,AbortSignal.timeout(this.config.timeout_ms)]) : AbortSignal.timeout(this.config.timeout_ms)
      });
      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        const error = new Error(`云端 ASR HTTP ${r.status}${errText ? `：${errText.slice(-200)}` : ''}`); error.httpStatus=r.status; throw error;
      }
      const data = await r.json();
      const text = String(data?.text ?? '').trim();
      this.lastMs = Date.now() - t0;
      this.state = 'ready';
      this.detail = `云端就绪（${this.lastMs} ms）`;
      return {
        text,
        final: text.length > 0,
        start_ms: meta.start_ms ?? 0,
        end_ms: meta.end_ms ?? (meta.start_ms ?? 0) + (pcm.length / 2 / 16000) * 1000,
        provider: this.name
      };
    } catch (e) {
      this.state = 'error';
      this.detail = `云端转写失败：${e.message}`;
      const error = new ContractError('ASR_TRANSCRIBE_FAILED', `云端 ASR 转写失败：${e.message}`);error.httpStatus=e.httpStatus;throw error;
    }
  }
  stop() { this.state = 'stopped'; this.detail = '已停止'; }
}

/** 字幕会话：管理 transcripts 待处理区与保存策略。 */
export class CaptionSession {
  constructor(db, opts = {}) {
    this.db = db;
    this.id = null;
    this.source = opts.source ?? 'loopback';
    this.providerName = opts.provider ?? 'LocalWhisper';
  }

  start() {
    const now = Date.now();
    const r = this.db.db.prepare(`INSERT INTO caption_sessions (source, provider, status, started_at)
      VALUES (?, ?, 'recording', ?)`).run(this.source, this.providerName, now);
    this.id = Number(r.lastInsertRowid);
    return this.id;
  }

  addTranscript({ start_ms, end_ms, text, is_final, selected, utterance_key = null }) {
    if (this.id == null) throw new ContractError('ASR_NOT_READY', '会话未开始');
    const r = this.db.db.prepare(`INSERT INTO transcripts
      (session_id, note_id, start_ms, end_ms, text, is_final, selected, utterance_key)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id,utterance_key) WHERE utterance_key IS NOT NULL DO NOTHING`).run(
      this.id, start_ms, end_ms, text, is_final ? 1 : 0, selected ? 1 : 0, utterance_key
    );
    return Number(r.lastInsertRowid);
  }

  markSelected(transcriptId, selected = true) {
    this.db.db.prepare('UPDATE transcripts SET selected = ? WHERE id = ? AND session_id = ?').run(selected ? 1 : 0, transcriptId, this.id);
  }

  transcripts() {
    return this.db.db.prepare('SELECT * FROM transcripts WHERE session_id = ? ORDER BY start_ms, id').all(this.id);
  }

  /**
   * 保存策略：
   *  - 'full'     整场所有 final 字幕入库为一条 transcript 笔记
   *  - 'selected' 仅已选片段入库
   *  - 'discard'  丢弃整场（删除待处理字幕，会话标记 discarded）
   */
  finish(strategy = 'full', sectionId = null, formatted = null) {
    if (this.id == null) throw new ContractError('ASR_NOT_READY', '会话未开始');
    const state = this.db.db.prepare('SELECT status FROM caption_sessions WHERE id = ?').get(this.id);
    if (!state || !['recording', 'review'].includes(state.status)) throw new Error('字幕会话已经处理，请刷新列表');
    const now = Date.now();
    let noteId = null;

    if (strategy === 'discard') {
      this.db.db.prepare('UPDATE caption_sessions SET status = ?, ended_at = ? WHERE id = ?').run('discarded', now, this.id);
      this.db.db.prepare('DELETE FROM transcripts WHERE session_id = ?').run(this.id);
      return { session_id: this.id, status: 'discarded', note_id: null };
    }

    if (!['full', 'selected'].includes(strategy)) throw new Error('未知保存策略');
    const rows = this.db.db.prepare('SELECT * FROM transcripts WHERE session_id = ? AND is_final = 1 AND (? = 0 OR selected = 1) ORDER BY start_ms, id')
      .all(this.id, strategy === 'selected' ? 1 : 0);
    if (!rows.length) throw new Error('没有可保存的字幕，请先选择片段或等待转写完成');
    const fullText = formatted ?? rows.map((r) => r.text).join('\n');

    const sec = sectionId != null ? this.db.getSection(sectionId) : null;
    const sectionName = sec?.name ?? '收集箱';
    // 生成 transcript 笔记（无标题，摘要用字幕首行）。
    this.db.db.exec('BEGIN');
    try {
      this.db.db.prepare(`INSERT INTO notes
        (title, summary, ocr_text, keywords, source_app, window_title, created_at, updated_at,
         capture_mode, latency_ms, provider, parse_ok, ocr_chars, section, section_id,
         kind, brief_json, detail_json, transcript_text)
        VALUES ('', ?, '', '[]', '', ?, ?, ?, 'transcript', 0, ?, 1, 0, ?, ?, 'transcript', '{}', '{}', ?)`).run(
        (rows[0]?.text ?? '').slice(0, 120), '',
        now, now,
        this.providerName,
        sectionName,
        sec ? sec.id : null,
        fullText
      );
      noteId = Number(this.db.db.prepare('SELECT last_insert_rowid() AS id').get().id);
      // 标记字幕片段归属。
      this.db.db.prepare('UPDATE transcripts SET note_id = ? WHERE session_id = ? AND is_final = 1 AND (? = 0 OR selected = 1)').run(noteId, this.id, strategy === 'selected' ? 1 : 0);
      this.db.db.prepare('UPDATE caption_sessions SET status = ?, ended_at = ? WHERE id = ?')
        .run(strategy === 'selected' ? 'saved_selected' : 'saved_full', now, this.id);
      this.db.db.exec('COMMIT');
    } catch (e) {
      this.db.db.exec('ROLLBACK');
      throw e;
    }
    const note = this.db.get(noteId);
    this.db.syncFts(noteId, '', (rows[0]?.text ?? '').slice(0, 120), fullText);
    return { session_id: this.id, status: strategy === 'selected' ? 'saved_selected' : 'saved_full', note_id: noteId, note };
  }

  /** 关闭时无操作：保留待处理会话（review 状态），供下次恢复。 */
  review() {
    if (this.id == null) return;
    this.db.db.prepare("UPDATE caption_sessions SET status = 'review', ended_at = ? WHERE id = ?").run(Date.now(), this.id);
  }
}

export function createAsrProvider(kind, config = {}) {
  if (kind === 'MockASR') return new MockAsrProvider();
  if (kind === 'LocalWhisper') {
    // 默认定位：项目 assets/bin/whisper 与 assets/models/ggml-base.bin。
    const root = config.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const binDir = config.binDir ?? path.join(root, 'assets', 'bin', 'whisper');
    const modelPath = config.modelPath ?? path.join(root, 'assets', 'models', 'ggml-base.bin');
    return new LocalWhisperProvider({ ...config, binDir, modelPath });
  }
  if (kind === 'OpenAiCompatibleASR') return new OpenAiCompatibleAsrProvider(config);
  return new MockAsrProvider();
}
