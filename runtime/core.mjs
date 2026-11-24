/** Screen Notes core: capture -> OCR -> summarize -> save, plus notes/settings/status API. */
import crypto from 'node:crypto';
import { LocalAsrComponents } from './local-asr-components.mjs';
import { StreamingCaptionController } from './streaming-caption-controller.mjs';
import { CaptionController } from './caption-controller.mjs';
import { checkReadiness } from './readiness.mjs';
import { createCompanionController } from './companion-controller.mjs';
import { CompanionSession, pacing } from './companion.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NoteStore } from './db.mjs';
import { selectReadingContent, ReadingMemory, focusFingerprint } from './reading.mjs';
import { createProvider, cleanOcrText, parseSummary } from './provider.mjs';
import { WindowsHelper, openFolder } from './win.mjs';
import { CaptionSession, createAsrProvider } from './asr.mjs';
import { SystemAudioCapture, locateAudioCapture } from './audio.mjs';
import { SpeechSegmenter, normalizeTranscript, joinTranscript, polishTranscript } from './speech.mjs';

/** 将 PNG Buffer 落库到 data/assets/YYYY/MM/<uuid>.png，返回相对路径与元信息。 */
function persistAsset(dataDir, png) {
  const now = new Date();
  const y = String(now.getFullYear());
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const relDir = path.join('assets', y, m);
  const absDir = path.join(dataDir, relDir);
  fs.mkdirSync(absDir, { recursive: true });
  const name = `${crypto.randomUUID()}.png`;
  const absPath = path.join(absDir, name);
  fs.writeFileSync(absPath, png);
  return {
    relative_path: path.join(relDir, name).replace(/\\/g, '/'),
    abs_path: absPath,
    bytes: png.length,
    sha256: crypto.createHash('sha256').update(png).digest('hex')
  };
}

const MODEL_SIZE = 491_400_032;
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

const DEFAULT_SETTINGS = {
  hotkey: 'Ctrl+Alt+N',
  companion_pace: 'balanced',
  reading_mode: 'auto',
  audio_source: 'loopback',
  caption_processing: {profile:'balanced',concurrency:2},
  caption_engine: 'auto',
  onboarding_done: false,
  auto_enabled: false,
  auto_interval_secs: 1,
  stable_ms: 1500,
  min_summary_interval_secs: 10,
  merge_window_minutes: 10,
  provider: 'OpenAiCompatible',
  api_config: { base_url: 'https://api.deepseek.com/v1', api_key: '', model: 'deepseek-chat', timeout_ms: 30000 },
  // 语音识别 API（独立于文本 api_config，分别授权分别降级）。
  asr_config: { base_url: 'https://api.siliconflow.cn/v1', api_key: '', model: 'FunAudioLLM/SenseVoiceSmall', language: 'zh', timeout_ms: 30000 },
  data_dir: '',
  max_ocr_chars: 600,
  capture_scope: 'full',
  always_on_top: true,
  // 屏幕字幕条样式：默认淡灰底（半透明白字），可调整大小/颜色/有无背景。
  caption_style: { font_size: 28, font_color: '#FFFFFF', background: true, bg_color: '#3C3C3C', opacity: 75, visible: true }
};

const CAPTURE_SCOPES = new Set(['full', 'rect']);
export const DEFAULT_SECTION_MANUAL = '收集箱';
export const DEFAULT_SECTION_AUTO = '自动记录';

// Adaptive auto-capture pacing. The scheduler ticks cheaply every 250 ms, but
// an actual screen grab only happens at CHECK[level]. Level 0 is "something
// just changed": fast checks, short settling, short cooldown. Consecutive
// near-identical frames (or near-identical OCR text) raise the level, so both
// the read frequency and the summarise frequency drop while the user stays on
// the same page. Any real visual change snaps straight back to level 0.
const AUTO_TICK_MS = 250;
const AUTO_CHECK_MS = [500, 1000, 2000, 4000, 6000];
const AUTO_STABLE_MS = [400, 600, 1000, 1400, 1400];
const AUTO_GAP_MS = [3000, 8000, 18000, 35000, 60000];
const AUTO_SAME_PAGE = 0.82;
// When the screen really changed we still skip if the text is almost identical
// (a scrolling terminal, a blinking caret). Only genuinely new wording gets a
// new summary, which keeps quiet-screen CPU close to zero.
const AUTO_SAME_PAGE_STRICT = 0.95;
const AUTO_MAX_LEVEL = AUTO_CHECK_MS.length - 1;

/** Character bigram Jaccard; cheap, language-neutral and works well for CJK. */
function textSimilarity(a, b) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, '');
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (t) => {
    const set = new Set();
    for (let i = 0; i + 1 < t.length; i++) set.add(t.slice(i, i + 2));
    return set;
  };
  const A = grams(x), B = grams(y);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter || 1);
}

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
};

function hashText(s) { return crypto.createHash('sha1').update(String(s)).digest('hex'); }

function fpDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 999;
  let sum = 0, n = 0;
  for (let i = 0; i + 1 < a.length; i += 2) {
    sum += Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16));
    n++;
  }
  return n ? sum / n : 999;
}

function appendOcr(existing, incoming) {
  const seen = new Set(String(existing).split(/\r?\n/).map((s) => s.trim()));
  const added = [];
  for (const line of String(incoming).split(/\r?\n/)) {
    const t = line.trim();
    if (t && !seen.has(t)) { seen.add(t); added.push(t); }
  }
  const merged = [String(existing).trim(), ...added].filter(Boolean).join('\n');
  return merged.length > 5000 ? merged.slice(-5000) : merged;
}

export class ScreenNotesCore {
  constructor(opts = {}) {
    this.root = opts.root ?? ROOT;
    this.dataDir = process.env.SCREEN_NOTES_DATA_DIR ?? path.join(this.root, 'data');
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.settingsPath = path.join(this.dataDir, 'settings.json');
    this.settings = this.loadSettings();
    this.localAsrComponents = new LocalAsrComponents(this.root);
    this.settings.data_dir = this.dataDir;

    this.modelPath = path.join(this.root, 'assets', 'models', 'qwen2.5-0.5b-instruct-q4_k_m.gguf');
    this.serverPath = path.join(this.root, 'assets', 'bin', 'llama-server.exe');
    this.db = new NoteStore(this.dataDir);
    this.win = new WindowsHelper();
    this.provider = createProvider(this.settings.provider, this.settings, {
      modelPath: this.modelPath,
      serverPath: this.serverPath
    });

    this.status = {
      phase: 'idle', message: '就绪', busy: false,
      auto_enabled: false, last_error: null, last_note_id: null, internal_foreground: false
    };
    this.stats = {
      notes_count: this.db.count(), captures: 0, ocr_calls: 0, summarize_calls: 0,
      skipped_no_change: 0, skipped_similar: 0, adaptive_checks: 0, adaptive_skips: 0,
      merged_notes: 0, model_load_ms: null,
      last_infer_ms: null, last_ocr_ms: null, last_total_ms: null
    };
    this.busy = false;
    this.autoTimer = null;
    this.autoStopping = false;
    // 手动两阶段捕获（capture_grab→capture_process）之间 helper 里持有的帧。
    // 这段时间 auto tick 必须跳过抓帧，否则会覆盖手动截图导致「帧已过期 / 读到
    // 别人的画面」。值为抓帧时间戳，process 完成或超时（2 分钟）后失效。
    this.manualFrameHeld = 0;
    this.lastFingerprint = null;
    this.lastChangeAt = 0;
    this.lastOcrHash = '';
    this.lastAutoAt = 0;
    // Adaptive pacing state.
    this.autoLevel = 0;
    this.nextCheckAt = 0;
    this.quietFrames = 0;
    this.lastAutoOcrText = '';
    this.lastForegroundAt = 0;
    this.lastForegroundInfo = {};
    this.autoSeq = 0;
    // Set when the screen really changed: even if the OCR text is still mostly
    // the same, a genuine visual change must never be swallowed by the
    // same-page back-off.
    this.forceProcess = false;
    this.changeBoostUntil = 0;
    // Cached for the 400-500 ms shell poll: no SQLite query on every poll.
    const latest = this.db.list('', 1)[0];
    this.lastNoteBrief = latest ? { id: latest.id, title: latest.title, summary: latest.summary } : null;
    this.initialized = false;
    this._captureChain = Promise.resolve();
    this.shellEnabled = false;
    this.shellQueue = [];
    // Frame id of the most recent capture_grab. The image itself stays in the
    // PowerShell helper's memory; this only guards against a stale/overwritten
    // frame being processed by a later request.
    this.lastGrabFrameId = 0;
    // 字幕会话与 ASR 提供方（懒加载）。
    this.captionSession = null;
    this.asrProvider = null;
    // 系统音频回环采集器（复用 audio_capture 二进制，懒加载）。
    this.audioCapture = null;
    this.audioBin = null;
    // 字幕转写循环定时器句柄。
    this._captionTranscribeTimer = null;
    // auto 灵感：最近一次真实内容变化的冻结快照（不写库，供「转为笔记」）。
    this.lastAutoInspire = null;
  }

  setShellEnabled(enabled) {
    this.shellEnabled = !!enabled;
  }

  /** Minimal state snapshot polled by the native mini panel. No DB reads here:
   *  the panel polls every 500 ms, so count/last-note are cached in memory. */
  shellState() {
    return {
      scope: this.settings.capture_scope,
      auto_enabled: this.status.auto_enabled,
      phase: this.status.phase,
      message: this.status.message,
      busy: this.status.busy || this.busy,
      notes_count: this.stats.notes_count,
      model_state: this.provider.status().state,
      hotkey: this.settings.hotkey,
      always_on_top: !!this.settings.always_on_top,
      last_note: this.lastNoteBrief,
      companion: this.lastAutoInspire?.generation === this.companionSession().generation ? { id: this.lastAutoInspire.id, title: this.lastAutoInspire.title, summary: this.lastAutoInspire.summary, seq: this.autoSeq } : null,
      internal_foreground: this.status.internal_foreground,
      auto_level: this.autoLevel,
      auto_check_ms: AUTO_CHECK_MS[this.autoLevel]
    };
  }

  /** Push an auto-capture lifecycle event to the native panel. Only real work
   *  emits events: a same-page skip is completely silent, so the bubble never
   *  keeps refreshing itself while nothing changed. */
  emitAutoEvent(type, payload = {}) {
    if (!this.shellEnabled || type === 'auto_processing') return;
    this.queueShellCommand({ type, ...payload });
  }

  queueShellCommand(cmd) {
    this.shellQueue.push(cmd);
    if (this.shellQueue.length > 32) this.shellQueue.splice(0, this.shellQueue.length - 32);
  }

  loadSettings() {
    let loaded = {};
    try { loaded = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8')); } catch { /* first run */ }
    const s = {
      ...DEFAULT_SETTINGS, ...loaded,
      api_config: { ...DEFAULT_SETTINGS.api_config, ...(loaded.api_config ?? {}) },
      asr_config: { ...DEFAULT_SETTINGS.asr_config, ...(loaded.asr_config ?? {}) },
      caption_style: { ...DEFAULT_SETTINGS.caption_style, ...(loaded.caption_style ?? {}) }
    };
    // 单机本地工具：provider 与 API 密钥允许持久化到本机 settings.json（用户自己机器自己用）。
    // Every start begins in manual mode: nothing is recorded until a key/button is pressed.
    s.auto_enabled = false;
    if (!CAPTURE_SCOPES.has(s.capture_scope)) s.capture_scope = 'full';
    return s;
  }

  saveSettings() {
    const copy = JSON.parse(JSON.stringify(this.settings));
    delete copy.data_dir;
    fs.writeFileSync(this.settingsPath, JSON.stringify(copy, null, 2), 'utf8');
  }

  async init(opts = {}) {
    if (this.initialized) return;
    await this.win.start();
    if (opts.hotkey !== false) {
      this.bindHotkey();
      this.win.on('hotkey', () => {
        if (this.busy) return;
        // With the native shell, capture is delegated so the shell can hide its own
        // windows (and show a region selector) before the frame is grabbed.
        if (this.shellEnabled) {
          this.queueShellCommand({ type: 'capture', scope: this.settings.capture_scope });
        } else {
          this.captureOnce('manual').catch((e) => this.setError(e));
        }
      });
      this.win.on('hotkey-error', (msg) => {
        this.status.last_error = `热键注册失败：${msg}`;
        this.status.message = `热键注册失败：${msg}`;
      });
    }
    if (this.settings.auto_enabled) this.startAuto();
    this.initialized = true;
  }

  bindHotkey() {
    try { this.win.setHotkey(this.settings.hotkey || 'Ctrl+Alt+N'); }
    catch (e) { this.status.last_error = `热键注册失败：${e.message}`; }
  }

  setPhase(phase, message) {
    this.phaseHistory ??= [];
    this.phaseHistory.push({ phase, at: Date.now() });
    this.phaseHistory = this.phaseHistory.slice(-100);
    this.companionSession().transition(phase, this.status.auto_enabled);
    this.status.phase = phase;
    this.status.message = message;
    this.status.busy = ['capturing', 'ocr', 'summarizing', 'saving'].includes(phase);
    this.status.last_error = phase === 'error' ? message : null;
  }

  setError(e) {
    const msg = e instanceof Error ? e.message : String(e);
    this.setPhase('error', msg);
  }

  isSelfForeground(fg) {
    const title = String(fg?.title ?? '');
    const proc = String(fg?.process ?? '').toLowerCase();
    // A project name in a browser/editor/chat title is not our own window.
    return /^屏幕笔记(?:\s*[·—-]\s*(?:笔记库|提示|字幕|悬浮窗|保存到哪里|关注区域|字幕样式))?(?:\s*[-—]\s*(?:Microsoft Edge|Google Chrome))?$/.test(title.trim());
  }

  /** Append a unit of work to the single serial capture chain. Every helper
   *  frame operation (snap/shot/ocr/clear) must run inside this chain so auto
   *  ticks and manual captures can never interleave and overwrite each other's
   *  frame in the PowerShell helper. */
  _runSerial(fn) {
    const task = this._captureChain.then(fn);
    this._captureChain = task.catch(() => {});
    return task;
  }

  /** Execute one capture and emit the auto bubble event when it produced a note. */
  async _captureWithAutoEvent(mode, opts) {
    const note = await this._captureOnce(mode, opts);
    if (mode === 'auto' && !note?.skipped) {
      this.autoSeq++;
      this.emitAutoEvent('auto_note', {
        seq: this.autoSeq, id: note.id, companion: true,
        title: note.title, summary: note.summary
      });
    }
    return note;
  }

  /** Serialize capture requests so auto-mode ticks can never collide with a manual capture. */
  captureOnce(mode = 'manual', opts = {}) {
    if (mode === 'auto') opts = { ...opts, generation: this.companionSession().generation };
    return this._runSerial(() => this._captureWithAutoEvent(mode, opts));
  }

  companionSession() { return this._companionSession ??= new CompanionSession(); }

  /** Full pipeline. When opts.text is supplied, capture/OCR are bypassed (test injection). */
  async _captureOnce(mode = 'manual', opts = {}) {
    if (mode === 'auto' && opts.generation !== undefined && opts.generation !== this.companionSession().generation) return { skipped: true, reason: '任务已失效' };
    const generation = this.companionSession().generation;
    if (mode === 'auto' && !opts.forceReply && Date.now() < this.companionSession().quietUntil) return { skipped: true, reason: '暂时安静中' };
    this.busy = true;
    const t0 = Date.now();
    let frameInfo = { foreground: {} };
    let ocrText = '';
    let ocrLanguage = '-';
    let reading = null;
    let png = null;
    try {
      this.stats.captures++;
      // When a frame was already grabbed by the shell, skip the "截屏中" phase:
      // the panel is back on screen and we are actually doing OCR/summarizing.
      if (!opts.snap) this.setPhase('capturing', '截屏中…');
      if (opts.text != null) {
        ocrText = String(opts.text);
        frameInfo = { foreground: opts.foreground ?? { process: 'selftest', title: '自检文本' } };
      } else {
        let snap;
        if (opts.region) {
          snap = await this.win.request('snapRegion', {
            scope: opts.region.scope || 'full',
            rect: opts.region.rect || null,
            points: opts.region.points || null
          }, 60000);
        } else {
          snap = opts.snap ?? await this.win.request('snap');
        }
        frameInfo = { ...snap, foreground: opts.snap?.foreground ?? snap.foreground ?? {} };
        // 抓取 PNG 用于图片落库（真实截屏、非文本注入、非外部图片时）。此时
        // helper 里的 frame 正是本次 snap/snapRegion 的画面（capture_process
        // 复用 capture_grab 的帧），shot 不会触发新的截屏。
        if (mode !== 'auto' && opts.with_image !== false && !opts.imagePath) {
          try { png = await this.win.shot(); } catch { png = null; }
        }
        if (mode === 'auto' && !opts.forceReply && this.isSelfForeground(frameInfo.foreground)) {
          this.stats.skipped_no_change++;
          return { skipped: true, reason: '本软件处于前台，自动截屏已暂停' };
        }
        this.setPhase('ocr', 'OCR 中…');
        const ocrStart = Date.now();
        const r = opts.imagePath
          ? await this.win.request('ocrfile', { path: opts.imagePath }, 90000)
          : await this.win.request('ocr', {}, 90000);
        this.stats.ocr_calls++;
        this.stats.last_ocr_ms = Date.now() - ocrStart;
        if (mode === 'auto') {
          const scope = (frameInfo.foreground?.process ?? '') + '|' + (frameInfo.foreground?.title ?? '');
          const signature = JSON.stringify(frameInfo.foreground?.bounds ?? null);
          if (this.userReadingRegion && (this.userReadingRegion.scope !== scope || this.userReadingRegion.width !== r.width || this.userReadingRegion.height !== r.height || this.userReadingRegion.signature !== signature)) this.userReadingRegion = null;
          reading = selectReadingContent(r, { title: frameInfo.foreground?.title, mode: this.settings.reading_mode ?? 'auto', rect: this.userReadingRegion?.rect });
          if (reading.confidence < .55 && !this.userReadingRegion) {
            const retry = await this.win.request('ocr', {}, 90000);
            const candidate = selectReadingContent(retry, { title: frameInfo.foreground?.title, mode: this.settings.reading_mode ?? 'auto' });
            if (candidate.confidence > reading.confidence || candidate.text.length > reading.text.length) reading = candidate;
          }
          this.lastReadingCandidate = { ...reading, scope, signature };
          if (reading.confidence < .55 && !opts.forceReply && r.layout?.length) {
            this.setPhase('idle', '这页正文不太确定，可点击“看错区域了”框选关注位置');
            return { skipped: true, reason: '正文识别不确定，请选择关注区域' };
          }
        } else reading = null;
        // A focused second pass enlarges small body text, excluding toolbar/ad clutter.
        if (reading?.rect && !['document-columns','code-editor','conversation'].includes(reading.strategy) && reading.text.length >= 150) {
          try {
            const focused = await this.win.request('ocrRegion', { rect: reading.rect }, 90000);
            if (focused.text && focused.text.trim().length >= reading.text.length * 0.55) {
              reading.text = focused.text; reading.enlarged = true;
            }
          } catch { /* The spatially filtered first pass remains usable. */ }
        }
        ocrText = reading?.text ?? r.text ?? '';
        ocrLanguage = r.language ?? '-';
        this.provider.ocrLanguage = ocrLanguage;
      }

      const readingLimit = mode === 'auto' ? Math.max(1800, this.settings.max_ocr_chars) : this.settings.max_ocr_chars;
      let cleaned = cleanOcrText(ocrText, readingLimit);
      if (mode === 'auto') {
        this.readingMemory ??= new ReadingMemory();
        if (reading?.rect) {
          this.readingFocus = { ...reading, signature: JSON.stringify(frameInfo.foreground?.bounds ?? null), scope: frameInfo.foreground?.process + '|' + frameInfo.foreground?.title };
          this.lastReadingFingerprint = focusFingerprint(frameInfo.fingerprint, reading.rect, reading.width, reading.height);
          this.lastReadingCheck = Date.now();
        }
        if (!opts.forceReply && this.companionSession().isMuted(cleaned)) { this.setPhase('done', '这个话题少说一些，等你主动聊'); return { skipped: true, reason: '话题已减少提醒' }; }
        const novelty = this.readingMemory.inspect(cleaned);
        if (!opts.forceReply && novelty.repeated) {
          this.stats.skipped_no_change++; this.stats.skipped_similar++; this.autoLevel = Math.min(AUTO_MAX_LEVEL, this.autoLevel + 1); this.setPhase('done', '这段正文已经看过，我先安静陪着你');
          return { skipped: true, reason: '同页正文已读，忽略固定导航及重复段落' };
        }
        if (!opts.forceReply && this.readingMemory.pages.length) cleaned = cleanOcrText(novelty.text, readingLimit);
      }
      if (cleaned.trim().length < 4) {
        if (mode === 'auto') { this.setPhase('idle', '这页文字较少，我先安静陪着你'); return { skipped: true, reason: '页面暂无可理解的文字' }; }
        throw new Error('OCR 未识别到有效文字（请确认画面有内容或切换中文语言包）');
      }
      const hash = hashText(cleaned);
      if (mode === 'auto' && !opts.forceReply && hash === this.lastOcrHash) {
        this.stats.skipped_no_change++;
        this.setPhase('done', '画面文字无实质变化，已跳过');
        return { skipped: true, reason: 'OCR 文本无变化' };
      }
      this.lastOcrHash = hash;

      // Same-page detection: when most of the recognised text is unchanged we
      // are probably still on the same page. Raise the pacing level (slower
      // reads AND slower processing) and skip the model entirely. No bubble
      // event is emitted, so the panel stays completely quiet.
      if (mode === 'auto' && !opts.forceReply) {
        const sim = textSimilarity(this.lastAutoOcrText, cleaned);
        this.lastAutoOcrText = cleaned;
        const samePageLimit = opts.forceProcess ? AUTO_SAME_PAGE_STRICT : AUTO_SAME_PAGE;
        if (sim >= samePageLimit) {
          this.autoLevel = Math.min(AUTO_MAX_LEVEL, this.autoLevel + 1);
          this.stats.skipped_similar++;
          this.setPhase('done', '同页内容基本未变，已自动降频');
          return { skipped: true, reason: '同页内容基本未变', similarity: Number(sim.toFixed(3)) };
        }
        this.autoLevel = 0; // real content change -> back to the fastest tier
      }
      if (mode === 'auto') {
        this.setPhase('summarizing', '正在看这页，想一想…');
        const result = await this.provider.summarize({ text: cleaned, maxChars: readingLimit, intent: 'companion', signal: this.companionSession().beginRequest(), context: this.companionSession().context(cleaned), detail: !!opts.detail });
        this.stats.summarize_calls++;
        this.stats.last_infer_ms = result.latency_ms ?? null;
        if (generation !== this.companionSession().generation) return { skipped: true, reason: '陪伴状态已变化，忽略旧结果' };
        if (opts.text == null) {
          const current = await this.win.request('foreground');
          if (current?.process !== frameInfo.foreground?.process || current?.title !== frameInfo.foreground?.title || JSON.stringify(current?.bounds ?? null) !== JSON.stringify(frameInfo.foreground?.bounds ?? null)) {
            this.lastOcrHash = ''; this.lastAutoOcrText = '';
            this.setPhase('idle', '页面已切换，正在等待阅读新页面');
            return { skipped: true, reason: '页面已切换，忽略旧结果' };
          }
        }
        if (opts.text == null && frameInfo.fingerprint && reading?.rect) {
          const latest = await this.win.request('snap');
          const before = focusFingerprint(frameInfo.fingerprint, reading.rect, reading.width, reading.height);
          const after = focusFingerprint(latest.fingerprint, reading.rect, reading.width, reading.height);
          if (before && after && fpDiff(before, after) > 12) {
            this.lastOcrHash = ''; this.lastAutoOcrText = '';
            this.setPhase('idle', '正文已经变化，等待新内容稳定后再聊');
            return { skipped: true, reason: '正文已变化，忽略过时理解' };
          }
        }
        if (result.parse_ok === false || result.raw === '') {
          this.lastOcrHash = ''; this.lastAutoOcrText = '';
          this.setPhase('error', '页面已读到，但生成回应失败；可点击“聊聊这页”重试');
          return { skipped: true, reason: '生成失败，可重试' };
        }
        if (!opts.forceReply && this.companionSession().duplicate(result.summary)) {
          this.setPhase('done', '这点想法刚刚说过，我先安静陪着你');
          return { skipped: true, reason: '回应重复' };
        }
        this.companionSession().remember(cleaned, result.summary);
        const inspire = {
          generation, id: crypto.randomUUID(), title: result.title || '一起看看这页', summary: result.summary,
          page_summary: result.page_summary ?? result.summary, insight: result.insight ?? '',
          reading_focus: reading ? { strategy: reading.strategy, rect: reading.rect, confidence: reading.confidence, mode: reading.mode } : null,
          ocr_text: cleaned, source_app: frameInfo.foreground?.process ?? '', window_title: frameInfo.foreground?.title ?? '',
          created_at: Date.now(), latency_ms: Date.now() - t0,
          brief: { display: result.summary, insight: result.insight ?? '', key_points: result.keywords ?? [], provider: result.provider, parse_ok: result.parse_ok !== false }
        };
        if (result.raw !== '' && result.parse_ok !== false) this.readingMemory.remember(ocrText);
        this.lastAutoInspire = inspire;
        this.companionHistory ??= [];
        this.companionHistory.unshift(inspire);
        this.companionHistory = this.companionHistory.slice(0, 20);
        this.stats.last_total_ms = inspire.latency_ms;
        this.lastOcrHash = hash;
        this.setPhase('done', result.raw === '' ? '页面已概括，云端暂不可用，可稍后再聊' : '有一点想法，想和你分享');
        return inspire;
      }

      const sourceApp = frameInfo.foreground?.process ?? '';
      const windowTitle = frameInfo.foreground?.title ?? '';
      const mergeKey = `${sourceApp}|${windowTitle}`;
      // 每条 auto 记录都成为独立笔记，并各自保存一张截图。旧版本把同一窗口
      // 10 分钟内的所有自动内容合并进第一条（replaceContent），导致「所有
      // 气泡只存进一条笔记、且合并分支不落图片」。用户要求 auto 与手动一致：
      // 每次真实变化一条独立笔记 + 一张图，故 auto 不再寻找合并目标。
      const candidate = null;

      this.setPhase('summarizing', '总结中…');
      const promptText = candidate ? appendOcr(candidate.ocr_text, cleaned) : cleaned;
      const result = await this.provider.summarize({ text: promptText, maxChars: this.settings.max_ocr_chars });
      this.stats.summarize_calls++;
      this.stats.last_infer_ms = result.latency_ms ?? null;
      this.stats.model_load_ms = this.provider.loadMs;
      this.setPhase('saving', '已保存');

      let note = null;
      if (candidate) {
        this.stats.merged_notes++;
        note = this.db.replaceContent(candidate.id, {
          title: result.title || candidate.title,
          summary: result.summary || candidate.summary,
          keywords: result.keywords?.length ? result.keywords : candidate.keywords,
          ocr_text: promptText,
          latency_ms: Date.now() - t0,
          provider: result.provider ?? 'LocalLlama',
          parse_ok: result.parse_ok,
          ocr_hash: hashText(promptText)
        });
      } else {
        note = this.db.insert({
          title: result.title,
          summary: result.summary,
          ocr_text: cleaned,
          keywords: result.keywords,
          source_app: sourceApp,
          window_title: windowTitle,
          capture_mode: mode,
          latency_ms: Date.now() - t0,
          provider: result.provider ?? 'LocalLlama',
          parse_ok: result.parse_ok,
          ocr_hash: hash,
          merge_key: mergeKey,
          section: opts.section ?? (mode === 'auto' ? DEFAULT_SECTION_AUTO : DEFAULT_SECTION_MANUAL)
        });
        // 图片落库并关联为笔记主图（新建笔记时）。合并到旧笔记时不重复保存，
        // 保留原笔记已有的主图。
        if (png && png.length > 0) {
          try {
            const meta = persistAsset(this.dataDir, png);
            this.db.attachPrimaryImage(note.id, {
              relative_path: meta.relative_path, mime: 'image/png',
              width: frameInfo.width ?? 0, height: frameInfo.height ?? 0,
              bytes: meta.bytes, sha256: meta.sha256
            });
            note = this.db.get(note.id);
          } catch { /* 图片保存失败不影响笔记本身 */ }
        }
      }

      this.stats.last_total_ms = Date.now() - t0;
      this.stats.notes_count = this.db.count();
      this.status.last_note_id = note.id;
      this.lastNoteBrief = { id: note.id, title: note.title, summary: note.summary };
      this.setPhase('done', candidate ? `已合并到笔记 #${note.id}` : `已保存笔记 #${note.id}（${this.stats.last_total_ms} ms）`);
      return note;
    } catch (e) {
      this.setError(e);
      throw e;
    } finally {
      this.busy = false;
      try { await this.win.request('clear'); } catch { /* helper may be closing */ }
    }
  }

  companionController() { return this._controller ??= createCompanionController(this, { AUTO_CHECK_MS, AUTO_MAX_LEVEL, AUTO_STABLE_MS, AUTO_TICK_MS, clamp, fpDiff }); }
  startAuto() { return this.companionController().startAuto(); }
  stopAuto() { return this.companionController().stopAuto(); }
  autoTick() { return this.companionController().autoTick(); }
  _autoTickInner() { return this.companionController()._autoTickInner(); }

  // ---------------- command dispatch ----------------
  async dispatch(cmd, args = {}) {
    switch (cmd) {
      case 'get_notes': {
        const notes = this.db.list(String(args.query ?? ''), clamp(args.limit, 1, 1000, 200), String(args.section ?? ''));
        const paths = this.db.primaryAssetPaths(notes.map((n) => n.id));
        return notes.map((n) => {
          const rel = paths.get(n.id);
          return rel ? { ...n, primary_asset_url: `/api/asset?path=${encodeURIComponent(rel)}` } : n;
        });
      }
      case 'get_note': {
        const n = this.db.get(Number(args.id));
        if (!n) throw new Error('笔记不存在');
        const paths = this.db.primaryAssetPaths([n.id]);
        const rel = paths.get(n.id);
        return rel ? { ...n, primary_asset_url: `/api/asset?path=${encodeURIComponent(rel)}` } : n;
      }
      case 'get_note_assets': {
        const assets = this.db.listAssets(Number(args.id), null);
        return assets.map((a) => ({ ...a, url: `/api/asset?path=${encodeURIComponent(a.relative_path)}` }));
      }
      case 'update_note': {
        const n = this.db.update(Number(args.id), String(args.title ?? ''), String(args.summary ?? ''));
        if (!n) throw new Error('笔记不存在');
        return n;
      }
      case 'delete_note': {
        this.db.delete(Number(args.id));
        this.stats.notes_count = this.db.count();
        return true;
      }
      case 'clear_notes': {
        this.db.clear();
        this.stats.notes_count = 0;
        this.lastOcrHash = '';
        return true;
      }
      case 'export_note': {
        const n = this.db.get(Number(args.id));
        if (!n) throw new Error('笔记不存在');
        return this.db.toMarkdown(n);
      }
      case 'capture_manual': {
        // Native shell owns the screen: queueing guarantees our windows are hidden
        // before the grab and lets rect/window/free modes show their selector.
        if (this.shellEnabled) {
          this.queueShellCommand({ type: 'capture', scope: this.settings.capture_scope });
          return { pending: true, scope: this.settings.capture_scope };
        }
        return this.captureOnce('manual', {});
      }
      /**
       * Two-phase capture for the native shell:
       *   capture_grab    -> GDI grab only (the panel is hidden for this instant)
       *   capture_process -> OCR + local model + save (the panel is visible again)
       * The PNG never leaves the helper process's memory; only metadata crosses
       * the HTTP boundary, so screenshots are still never written to disk.
       */
      case 'capture_grab': {
        if (this.busy) throw new Error('上一条笔记仍在处理中，请稍候');
        const scope = CAPTURE_SCOPES.has(args.scope) ? args.scope : 'full';
        const region = scope === 'full' ? null : {
          scope,
          rect: args.rect ?? null,
          points: Array.isArray(args.points) ? args.points : null
        };
        this.setPhase('capturing', '截屏中…');
        const snap = region
          ? await this.win.request('snapRegion', {
              scope: region.scope, rect: region.rect, points: region.points
            }, 60000)
          : await this.win.request('snap');
        this.lastGrabFrameId = Number(snap.frame) || 0;
        this.manualFrameHeld = Date.now();
        this.setPhase('processing', '画面已抓取，正在整理…');
        return { snap, scope, grabbed_at: Date.now() };
      }
      case 'capture_process': {
        const snap = args.snap && typeof args.snap === 'object' ? args.snap : null;
        if (!snap) throw new Error('缺少截屏帧，请先执行 capture_grab');
        if (this.lastGrabFrameId && Number(snap.frame) !== this.lastGrabFrameId) {
          this.manualFrameHeld = 0;
          throw new Error('截屏帧已过期，请重新记录');
        }
        try {
          return await this.captureOnce('manual', { snap, section: args.section });
        } finally {
          // 手动帧处理完毕，解除门闩，auto 可以继续抓帧。
          this.manualFrameHeld = 0;
        }
      }
      // Backwards-compatible one-shot entry (loop tests, CLI and non-shell callers).
      case 'capture_execute': {
        const grabbed = await this.dispatch('capture_grab', args);
        return this.dispatch('capture_process', { ...args, snap: grabbed.snap });
      }
      case 'set_always_on_top': {
        this.settings.always_on_top = args.enabled !== false;
        this.saveSettings();
        return JSON.parse(JSON.stringify(this.settings));
      }
      case 'shell_poll': return { commands: this.shellQueue.splice(0), state: this.shellState() };
      case 'get_shell_state': return this.shellState();
      case 'set_capture_scope': {
        const scope = String(args.scope ?? '');
        if (!CAPTURE_SCOPES.has(scope)) throw new Error(`不支持的截屏范围：${scope}`);
        this.settings.capture_scope = scope;
        this.saveSettings();
        return JSON.parse(JSON.stringify(this.settings));
      }
      case 'list_sections': return this.db.listSections();
      case 'set_note_section': {
        const n = this.db.setSection(Number(args.id), String(args.section ?? ''));
        if (!n) throw new Error('笔记不存在');
        return n;
      }
      case 'capture_with_image': return this.captureOnce('manual', { imagePath: String(args.imagePath ?? '') });
      case 'capture_with_text': return this.captureOnce(String(args.mode ?? 'manual'), {
        text: String(args.text ?? ''), foreground: args.foreground
      });
      case 'set_auto_mode': {
        // 关闭必须等待在途 tick 排空，否则返回后残留任务仍会污染手动截图。
        if (args.enabled) this.startAuto(); else await this.stopAuto();
        this.saveSettings();
        return this.status;
      }
      case 'get_status': return { ...this.status };
      case 'get_stats': {
        this.stats.notes_count = this.db.count();
        return { ...this.stats };
      }
      case 'get_settings': return JSON.parse(JSON.stringify(this.settings));
      case 'update_settings': {
        const s = args.settings ?? {};
        const prevHotkey = this.settings.hotkey;
        this.settings = {
          ...this.settings,
          hotkey: String(s.hotkey || this.settings.hotkey).trim(),
          auto_interval_secs: clamp(s.auto_interval_secs, 1, 10, this.settings.auto_interval_secs),
          stable_ms: clamp(s.stable_ms, 300, 10000, this.settings.stable_ms),
          reading_mode: ['auto','article','document','chat','code'].includes(s.reading_mode) ? s.reading_mode : (this.settings.reading_mode ?? 'auto'),
          caption_engine: ['auto','cloud','local'].includes(s.caption_engine)?s.caption_engine:this.settings.caption_engine,
          caption_processing: {profile:['balanced','fast'].includes(s.caption_processing?.profile)?s.caption_processing.profile:(this.settings.caption_processing?.profile??'balanced'),concurrency:clamp(s.caption_processing?.concurrency,1,2,this.settings.caption_processing?.concurrency??2)},
          audio_source: ['loopback','microphone'].includes(s.audio_source) ? s.audio_source : (this.settings.audio_source ?? 'loopback'),
          onboarding_done: s.onboarding_done === undefined ? !!this.settings.onboarding_done : !!s.onboarding_done,
          companion_pace: ['quiet', 'balanced', 'active'].includes(s.companion_pace) ? s.companion_pace : (this.settings.companion_pace ?? 'balanced'),
          min_summary_interval_secs: clamp(s.min_summary_interval_secs, 2, 120, this.settings.min_summary_interval_secs),
          merge_window_minutes: clamp(s.merge_window_minutes, 0, 120, this.settings.merge_window_minutes),
          max_ocr_chars: clamp(s.max_ocr_chars, 200, 6000, this.settings.max_ocr_chars),
          capture_scope: CAPTURE_SCOPES.has(s.capture_scope) ? s.capture_scope : this.settings.capture_scope,
          provider: (s.provider === 'OpenAiCompatible' || s.provider === 'LocalLlama') ? s.provider : this.settings.provider,
          api_config: {
            ...this.settings.api_config,
            base_url: String(s.api_config?.base_url ?? this.settings.api_config.base_url),
            model: String(s.api_config?.model ?? this.settings.api_config.model),
            timeout_ms: clamp(s.api_config?.timeout_ms, 1000, 120000, this.settings.api_config.timeout_ms),
            api_key: s.api_config?.api_key !== undefined ? String(s.api_config.api_key) : this.settings.api_config.api_key
          },
          asr_config: {
            ...this.settings.asr_config,
            base_url: String(s.asr_config?.base_url ?? this.settings.asr_config.base_url),
            model: String(s.asr_config?.model ?? this.settings.asr_config.model),
            language: String(s.asr_config?.language ?? this.settings.asr_config.language),
            timeout_ms: clamp(s.asr_config?.timeout_ms, 1000, 120000, this.settings.asr_config.timeout_ms),
            api_key: s.asr_config?.api_key !== undefined ? String(s.asr_config.api_key) : this.settings.asr_config.api_key
          },
          caption_style: s.caption_style
            ? {
                font_size: clamp(s.caption_style.font_size, 12, 72, this.settings.caption_style?.font_size ?? 28),
                font_color: String(s.caption_style.font_color ?? this.settings.caption_style?.font_color ?? '#FFFFFF'),
                background: s.caption_style.background !== undefined ? !!s.caption_style.background : (this.settings.caption_style?.background ?? true),
                bg_color: String(s.caption_style.bg_color ?? this.settings.caption_style?.bg_color ?? '#3C3C3C'),
                opacity: clamp(s.caption_style.opacity, 20, 100, this.settings.caption_style?.opacity ?? 75),
                visible: s.caption_style.visible !== undefined ? !!s.caption_style.visible : (this.settings.caption_style?.visible ?? true)
              }
            : this.settings.caption_style
        };
        if (this.settings.hotkey !== prevHotkey) this.bindHotkey();
        // 提供方/密钥变更后重建 provider，使新配置即时生效。
        this.provider = createProvider(this.settings.provider, this.settings, {
          modelPath: this.modelPath, serverPath: this.serverPath
        });
        // The scheduler interval is fixed and its pacing is adaptive, so there
        // is no timer to rebuild. Let the next tick run immediately instead.
        this.nextCheckAt = 0;
        this.saveSettings();
        return JSON.parse(JSON.stringify(this.settings));
      }
      case 'get_provider_status': return this.provider.status();
      case 'start_model': return this.provider.ensureStarted();
      // ---- 分区实体 ----
      case 'list_section_rows': return this.db.listSectionRows();
      case 'create_section': return this.db.createSection(args.name, args.path ?? '');
      case 'rename_section': return this.db.renameSection(Number(args.id), args.name);
      case 'delete_section': return this.db.deleteSection(Number(args.id));
      case 'set_section_path': return this.db.setSectionPath(Number(args.id), args.path ?? '');
      case 'pick_folder': return this.win.pickFolder(String(args.initial ?? ''));
      // ---- 草稿 ----
      case 'list_drafts': return this.db.listDrafts(args.status ?? null);
      case 'get_draft': {
        const d = this.db.getDraft(Number(args.id));
        if (!d) throw new Error('草稿不存在');
        return d;
      }
      case 'discard_draft': {
        if (!this.db.discardDraft(Number(args.id))) throw new Error('草稿不存在');
        return true;
      }
      case 'commit_draft': {
        const sectionId = args.section_id != null ? Number(args.section_id) : null;
        const note = this.db.commitDraft(Number(args.id), sectionId);
        // 分区指定了磁盘文件夹时，把图片复制到该文件夹（原始仍在 data/assets）。
        const sec = sectionId != null ? this.db.getSection(sectionId) : null;
        if (sec?.path) {
          this._copyAssetsToSectionFolder(note.id, sec.path);
        }
        this.stats.notes_count = this.db.count();
        this.status.last_note_id = note.id;
        this.lastNoteBrief = { id: note.id, title: note.title, summary: note.summary };
        return note;
      }
      // ---- 手动截屏 → 草稿（图片落库 + 不建正式笔记）----
      case 'capture_to_draft': return this.captureToDraft(args);
      // ---- 字幕会话 ----
      case 'start_caption': {
        if (this._captionStarting) throw new Error('字幕正在启动，请稍候');
        this._captionStarting = true;
        try {
        if (this.captionSession) throw new Error('字幕会话已在进行中');
        const provider = this.captionProvider(args.provider);
        const source = String(args.source ?? this.settings.audio_source ?? 'loopback');
        const timing = this._captionTiming = { startedAt: Date.now(), provider, source };
        // 云端 ASR 从 settings.asr_config 取配置（分别授权，密钥不落明文）。
        const asrCfg = provider === 'OpenAiCompatibleASR'
          ? {
              base_url: this.settings.asr_config?.base_url,
              api_key: this.settings.asr_config?.api_key,
              model: this.settings.asr_config?.model,
              language: this.settings.asr_config?.language,
              timeout_ms: this.settings.asr_config?.timeout_ms
            }
          : {};
        this.asrProvider = provider==='LocalStreamingASR'?{name:provider,ready:this.localAsrComponents.status().ready,status:()=>({state:'ready',detail:'本地中文流式'}),stop(){}}:createAsrProvider(provider, { root: this.root, ...asrCfg });
        if(provider==='LocalStreamingASR'&&!this.asrProvider.ready)throw new Error('本地模型未安装，请在设置中安装本地识别组件');
        if (provider !== 'MockASR' && !this.asrProvider.ready) throw new Error('语音识别尚未配置或不可用，请在设置中填写 ASR 地址、模型和密钥');
        if (!['loopback','microphone'].includes(source)) throw new Error('请选择系统声音或麦克风');

        // 真实音频采集：source=loopback 时启动系统声音回环（音频不落盘）。
        let audio_ok = false;
        let audio_detail = '未启用';
        if (['loopback','microphone'].includes(source)) {
          this.audioBin = locateAudioCapture(this.root);
          if (!this.audioBin && source !== 'microphone') {
            audio_detail = '系统音频采集组件缺失（tools/audio_capture.exe）';
          } else {
            try {
              this.audioCapture = new SystemAudioCapture(this.audioBin, {source});
              const onLevel = ({rms}) => {
                if (rms < 0.006) return;
                timing.soundAt = Date.now();
                this.audioCapture?.off('level', onLevel);
              };
              this.audioCapture.on('level', onLevel);
              this.audioCapture.on('error', (e) => { this.status.last_error = e.message; this.status.message = e.message; });
              this.audioCapture.start();
              await this.audioCapture.waitUntilReady(6000);
              audio_ok = true;
              audio_detail = source === 'microphone' ? '默认麦克风采集中（16k mono）' : '系统声音回环采集中（16k mono）';
            } catch (e) {
              audio_detail = `音频采集失败：${e.message}`;
              this.audioCapture?.stop(); this.audioCapture = null;
            }
          }
        }
        if (!audio_ok && provider !== 'MockASR') throw new Error(audio_detail + '；请检查音源或打开使用检查');
        this.captionSession = new CaptionSession(this.db, { source, provider });
        const id = this.captionSession.start();
        timing.sessionId = id;
        // 本地 whisper 是否就绪（决定能否真实转写）。
        const asr_ready = this.asrProvider?.ready === true;
        if (asr_ready) {
          try { await this._startCaptionTranscribeLoop(); } catch(e) { this._captionControl?.cancel();this.captionSession.review();this.captionSession=null;this._stopAudioCapture();throw e; }
        }
        this.status.last_error=null;
        timing.readyAt = Date.now();
        this.status.message = `字幕会话 #${id} 已开始（${provider}${audio_ok ? ' · 音频采集中' : ''}${asr_ready ? ' · 转写就绪' : ''}）`;
        return { session_id: id, provider, source, audio_ok, audio_detail, asr_ready };
        } finally { this._captionStarting = false; }
      }
      case 'caption_feed': {
        // 测试/集成：注入一段字幕（真实链路由音频采集调用）。
        if (!this.captionSession) throw new Error('字幕会话未开始');
        const tid = this.captionSession.addTranscript({
          start_ms: Number(args.start_ms ?? 0),
          end_ms: Number(args.end_ms ?? (args.start_ms ?? 0) + 1000),
          text: String(args.text ?? ''),
          is_final: args.is_final !== false,
          selected: false
        });
        return { transcript_id: tid };
      }
      case 'request_caption_review': {
        this.pendingCaptionReview = Number(args.session_id);
        return true;
      }
      case 'get_caption_session': {
        const row = this.db.db.prepare('SELECT * FROM caption_sessions WHERE id = ?').get(Number(args.session_id));
        if (!row) throw new Error('字幕会话不存在');
        if (this.pendingCaptionReview === Number(row.id)) this.pendingCaptionReview = null;
        return { ...row, issues: this.db.db.prepare('SELECT * FROM caption_issues WHERE session_id=? AND resolved=0 ORDER BY start_ms').all(row.id), retry_available: this._captionControl?.session.id===Number(row.id)&&!!this._captionControl.failed.size, transcripts: this.db.db.prepare('SELECT * FROM transcripts WHERE session_id = ? ORDER BY start_ms, id').all(row.id) };
      }
      case 'caption_mark': {
        const session = this._captionFor(args);
        session.markSelected(Number(args.transcript_id), args.selected !== false);
        return true;
      }
      case 'get_caption_audio': {
        // 供 ASR 拉取最近 N 毫秒的 PCM（base64），音频仍只在内存、不落盘。
        if (!this.audioCapture) throw new Error('音频采集未启动');
        const ms = Number(args.ms ?? 1000);
        const buf = this.audioCapture.readRecent(ms);
        return {
          bytes: buf.length,
          sample_rate: this.audioCapture.sampleRate,
          channels: this.audioCapture.channels,
          pcm_base64: buf.toString('base64')
        };
      }
      case 'caption_save_scope': {
        const session = this._captionFor(args);
        const isActive = session === this.captionSession;
        if (isActive) await this._drainCaption();
        const strategy = String(args.strategy ?? 'full');
        const unresolved=this.db.db.prepare('SELECT count(*) AS n FROM caption_issues WHERE session_id=? AND resolved=0').get(session.id).n;
        if(strategy!=='discard'&&unresolved&&!args.allow_incomplete)throw new Error('有未识别片段，请先重试，或明确选择保存已识别内容');
        let formatted = null;
        if (args.polish === true && strategy !== 'discard' && session.transcripts().some(r => r.is_final && (strategy !== 'selected' || r.selected))) {
          const rows = session.transcripts().filter(r => r.is_final && (strategy !== 'selected' || r.selected));
          const text = joinTranscript(rows);
          try { formatted = await polishTranscript(text, this.settings.api_config); }
          catch (e) { this.status.message = e.message + '，已保留原始转写'; }
        }
        const result = session.finish(strategy, args.section_id != null ? Number(args.section_id) : null, formatted);
        if (this.pendingCaptionReview === session.id) this.pendingCaptionReview = null;
        if (result.note_id != null) {
          this.stats.notes_count = this.db.count();
          this.status.last_note_id = result.note_id;
        }
        if (isActive) {
          this.captionSession = null;
          this._stopCaptionTranscribeLoop();
          this._stopAudioCapture();
        }
        if(this._captionControl?.session.id===session.id)this._captionControl.cancel();
        return result;
      }
      case 'stop_caption': {
        if (this._captionStarting) throw new Error('字幕正在准备，请稍候');
        if (this._captionStopPromise) return this._captionStopPromise;
        if (!this.captionSession) throw new Error('字幕会话未开始');
        this._captionStopPromise = Promise.resolve().then(async () => {
          const timing = this._captionTiming;
          if (timing?.sessionId === this.captionSession.id) timing.stopAt = Date.now();
          await this._drainCaption();
          if (timing?.stopAt) timing.drainedAt = Date.now();
          this.captionSession.review();
          const id = this.captionSession.id;
          this.captionSession = null;
          this._stopCaptionTranscribeLoop();
          this._stopAudioCapture();
          this.status.message = `字幕 #${id} 已停止，请选择保存分区`;
          return { session_id: id, status: 'review' };
        });
        try { return await this._captionStopPromise; }
        finally { this._captionStopPromise = null; }
      }
      case 'list_caption_sessions': {
        return this.db.db.prepare('SELECT * FROM caption_sessions ORDER BY started_at DESC').all().map((r) => ({
          id: Number(r.id), source: r.source, provider: r.provider, status: r.status,
          started_at: Number(r.started_at), ended_at: r.ended_at == null ? null : Number(r.ended_at),
          review_deadline: r.review_deadline == null ? null : Number(r.review_deadline)
        }));
      }
      case 'local_asr_status': return this.localAsrComponents.status();
      case 'install_local_asr': if(this.captionSession)throw new Error('请先停止字幕再安装组件');return this.localAsrComponents.install(args.repair===true);
      case 'retry_caption_segments': {
        if(!this._captionControl||this._captionControl.session.id!==Number(args.session_id))throw new Error('此会话的音频已释放，无法重试；可保存已识别内容');
        await this._captionControl.retryFailed();
        if(!this.db.db.prepare('SELECT count(*) AS n FROM caption_issues WHERE session_id=? AND resolved=0').get(Number(args.session_id)).n)this.status.last_error=null;
        return true;
      }
      case 'caption_live': {
        const active=!!this.captionSession;
        const live=active&&this._captionControl?.session.id===this.captionSession.id?this._captionControl.snapshot():null;
        const timing = this._captionTiming;
        const waitingForSound = active && timing?.sessionId === this.captionSession.id &&
          timing.readyAt && !timing.soundAt && Date.now() - timing.readyAt >= 5000;
        const rows=active&&!live?this.db.db.prepare('SELECT id,text,start_ms,end_ms FROM transcripts WHERE session_id=? AND is_final=1 ORDER BY id DESC LIMIT 3').all(this.captionSession.id).reverse():[];
        return {active, starting:this._captionStarting === true, stopping:!!this._captionStopPromise, waiting_for_sound:!!waitingForSound, style:this.settings.caption_style, ...(live ?? {session_id:this.captionSession?.id ?? null,event_seq:rows.at(-1)?.id??0,current:null,recent:rows,display_text:rows.at(-1)?.text??''}),error:this.status.last_error};
      }
      case 'caption_painted': {
        const timing = this._captionTiming;
        const firstText = this._captionControl?.events.firstTextAt;
        const at = Number(args.at);
        if (timing && timing.sessionId === Number(args.session_id) &&
            this._captionControl?.session.id === timing.sessionId &&
            firstText && at >= firstText && at <= Date.now()) timing.paintedAt ??= at;
        return true;
      }
      case 'caption_timing': {
        const timing = this._captionTiming;
        if (!timing?.sessionId) return null;
        const control = this._captionControl?.session.id === timing.sessionId ? this._captionControl : null;
        const elapsed = (a,b) => a != null && b != null && a >= b ? a-b : null;
        return {
          session_id: timing.sessionId, provider:timing.provider, source:timing.source,
          startup_ms:elapsed(timing.readyAt,timing.startedAt),
          heard_sound:!!timing.soundAt,
          first_submit_ms:timing.provider === 'LocalStreamingASR' ? null : elapsed(control?.firstSubmitAt,timing.soundAt),
          first_text_ms:elapsed(control?.events.firstTextAt,timing.soundAt),
          first_final_ms:elapsed(control?.events.firstFinalAt,timing.soundAt),
          first_paint_ms:elapsed(timing.paintedAt,timing.soundAt),
          paint_delay_ms:elapsed(timing.paintedAt,control?.events.firstTextAt),
          stop_ms:elapsed(timing.drainedAt,timing.stopAt)
        };
      }
      case 'caption_status': {
        // 字幕条轮询：是否有进行中的会话 + 最近几条 final 字幕文本。
        const active = this.captionSession != null;
        let lines = [];
        if (active) {
          const afterId = Number(args.after_id);
          const rows = Number.isFinite(afterId) && afterId >= 0
            ? this.db.db.prepare('SELECT id, text FROM transcripts WHERE session_id = ? AND is_final = 1 AND id > ? ORDER BY id LIMIT 32').all(this.captionSession.id, afterId)
            : this.db.db.prepare('SELECT id, text FROM transcripts WHERE session_id = ? AND is_final = 1 ORDER BY id DESC LIMIT 3').all(this.captionSession.id).reverse();
          lines = rows.map((r) => ({ id: Number(r.id), text: r.text }));
        }
        const queue = active ? this._captionControl?.snapshot() : null;
        return {
          active,
          session_id: active ? this.captionSession.id : null,
          provider: active ? this.captionSession.providerName : null,
          lines,
          pending_review_id: this.pendingCaptionReview ?? null,
          queued_segments: queue?.queued_segments ?? 0,
          waiting_audio_ms: queue?.waiting_audio_ms ?? 0,
          failed_segments: queue?.failed_segments ?? 0,
          audio_running: this.audioCapture?.running ?? false,
          audio_bytes: this.audioCapture?.bytesCaptured ?? 0,
          asr_status: this.asrProvider?.status?.() ?? null,
          error: this.status.last_error,
          style: this.settings.caption_style ?? null
        };
      }
      case 'set_caption_style': {
        // 更新字幕条样式（字体大小/颜色/背景），持久化到 settings。
        const cur = this.settings.caption_style ?? {};
        const s = args.style ?? {};
        this.settings.caption_style = {
          font_size: clamp(s.font_size, 12, 72, cur.font_size ?? 28),
          font_color: String(s.font_color ?? cur.font_color ?? '#FFFFFF'),
          background: s.background !== undefined ? !!s.background : (cur.background ?? true),
          bg_color: String(s.bg_color ?? cur.bg_color ?? '#3C3C3C'),
          opacity: clamp(s.opacity, 20, 100, cur.opacity ?? 75),
          visible: s.visible !== undefined ? !!s.visible : (cur.visible ?? true)
        };
        this.saveSettings();
        return this.settings.caption_style;
      }
      // ---- auto 灵感（不写库）与转正 ----
      case 'auto_inspire': {
        // 生成一次 transient 灵感：OCR + Brief，但不写 notes/drafts/FTS。
        const inspire = await this.autoInspire(args);
        return inspire;
      }
      case 'auto_promote': {
        // 冻结最近一次 auto 灵感为草稿（转正），供分区询问后提交。
        if (!this.lastAutoInspire) throw new Error('没有可转正的 auto 灵感');
        const d = this.db.createDraft({
          kind: 'auto_promoted',
          brief: this.lastAutoInspire.brief,
          ocr_raw: this.lastAutoInspire.ocr_text,
          ocr_clean: this.lastAutoInspire.ocr_text,
          ocr_lines: this.lastAutoInspire.ocr_lines ?? [],
          source_app: this.lastAutoInspire.source_app ?? '',
          window_title: this.lastAutoInspire.window_title ?? ''
        });
        this.lastAutoInspire = null;
        return d;
      }
      case 'check_readiness': return checkReadiness(this, { network: args.network === true, audio: args.audio === true });
      case 'complete_onboarding': this.settings.onboarding_done = true;this.saveSettings();return true;
      case 'open_note_location': {
        const note = this.db.get(Number(args.id));
        if (!note) throw new Error('笔记不存在');
        return openFolder(this.dataDir);
      }
      case 'caption_style_preset': {
        const presets={default:{font_size:28,font_color:'#FFFFFF',background:true,bg_color:'#3C3C3C',opacity:75,visible:true},contrast:{font_size:32,font_color:'#FFFFFF',background:true,bg_color:'#111111',opacity:95,visible:true},large:{font_size:42,font_color:'#FFE08A',background:true,bg_color:'#202020',opacity:85,visible:true}};
        if (!presets[args.name]) throw new Error('未知字幕样式');
        return this.dispatch('set_caption_style',{style:presets[args.name]});
      }
      case 'request_reading_region': {
        if (!this.shellEnabled) throw new Error('请从启动脚本打开软件后，使用小窗口的区域选择');
        this.companionSession().invalidate(); this._selectingReadingRegion = Date.now(); this.pendingReadingRegion = this.lastReadingCandidate ?? this.readingFocus;
        this.queueShellCommand({ type: 'pick_reading_region' }); return true;
      }
      case 'set_reading_region': {
        const info = this.pendingReadingRegion ?? this.lastReadingCandidate ?? this.readingFocus;
        this._selectingReadingRegion = 0; this.pendingReadingRegion = null;
        if (!info) throw new Error('请先回到要阅读的页面，点击“聊聊这页”，然后再选择区域');
        const r = args.rect;
        if (!r || ![r.x,r.y,r.w,r.h].every(Number.isFinite) || r.x<0 || r.y<0 || r.w<8 || r.h<8 || r.x+r.w>info.width || r.y+r.h>info.height) throw new Error('关注区域超出屏幕，请重新选择');
        this.userReadingRegion = {rect:{x:r.x,y:r.y,w:r.w,h:r.h},scope:info.scope,width:info.width,height:info.height,signature:info.signature ?? JSON.stringify(null)};
        this.companionSession().invalidate(); this.lastOcrHash='';this.lastAutoOcrText='';this.readingMemory=new ReadingMemory();this.readingFocus=null;return true;
      }
      case 'cancel_reading_region': this._selectingReadingRegion=0;this.pendingReadingRegion=null;return true;
      case 'clear_reading_region': this.companionSession().invalidate();this.userReadingRegion=null;this.readingFocus=null;this.lastReadingCandidate=null;this.lastOcrHash='';this.lastAutoOcrText='';return true;
      case 'show_reading_region': {
        const info = this.lastReadingCandidate ?? this.readingFocus;
        if (!info?.rect) throw new Error('当前没有确定的正文区域，请先聊聊这页');
        if (!this.shellEnabled) throw new Error('请使用桌面小窗口查看识别范围');
        const fg=await this.win.request('foreground');
        if ((fg.process+'|'+fg.title)!==info.scope && !this.isSelfForeground(fg)) throw new Error('当前页面已切换，请先在阅读页面重新聊聊');
        this.queueShellCommand({type:'highlight_reading_region',rect:info.rect});return true;
      }
      case 'companion_expand': {
        const item = this.companionHistory?.find(i => i.id === args.id);
        if (!item) throw new Error('这条灵感已经过期，请重新聊聊这页');
        return this.captureOnce('auto', { text: item.ocr_text, foreground: { process: item.source_app, title: item.window_title }, forceReply: true, detail: true });
      }
      case 'companion_feedback': {
        if (args.action === 'quiet') { this.companionSession().invalidate(); this.companionSession().quietUntil = Date.now() + 10 * 60000; }
        else if (args.action === 'less') { this.companionSession().muted.push(String(this.lastAutoInspire?.ocr_text ?? '').slice(0,4000)); this.companionSession().muted = this.companionSession().muted.slice(-12); }
        else if (args.action === 'resume') this.companionSession().quietUntil = 0;
        else throw new Error('未知反馈');
        return true;
      }
      case 'get_diagnostics': return { phases: this.phaseHistory ?? [], stats: { ...this.stats }, queued_auto: !!this._autoTickPending, session_entries: this.companionSession().entries.length };
      case 'clear_companion_memory': {
        this.companionSession().clear(); this.readingMemory = new ReadingMemory();
        this.lastOcrHash = ''; this.lastAutoOcrText = ''; this.readingFocus = null;
        this.lastAutoInspire = null; this.companionHistory = [];
        this.shellQueue = this.shellQueue.filter(c => c.type !== 'auto_note');
        this.setPhase('idle', '阅读记忆已清空，可以重新聊聊这页'); return true;
      }
      case 'get_companion_state': return { current: this.lastAutoInspire ?? null, history: this.companionHistory ?? [], enabled: this.status.auto_enabled, state: this.companionSession().state, quiet_until: this.companionSession().quietUntil, focus: this.lastReadingCandidate ? {rect:this.lastReadingCandidate.rect,strategy:this.lastReadingCandidate.strategy,confidence:this.lastReadingCandidate.confidence} : null };
      case 'collect_inspire': {
        const item = (this.companionHistory ?? []).find(i => i.id === args.id);
        if (!item) throw new Error('这条灵感已经过期，请刷新当前页面');
        if (item.note_id) return this.db.get(item.note_id);
        const note = this.db.insert({ title: item.title, summary: item.summary, ocr_text: item.ocr_text, keywords: item.brief.key_points ?? [], source_app: item.source_app, window_title: item.window_title, capture_mode: 'manual', provider: item.brief.provider ?? 'OpenAiCompatible', parse_ok: item.brief.parse_ok, latency_ms: item.latency_ms, ocr_hash: hashText(item.ocr_text), merge_key: '', section: '收集箱' });
        item.note_id = note.id; this.stats.notes_count = this.db.count(); this.status.last_note_id = note.id;
        return note;
      }
      case 'clear_auto_inspire': { this.lastAutoInspire = null; return true; }
      case 'open_data_dir': return openFolder(this.dataDir);
      case 'selftest': return this.selftest();
      case 'get_config': {
        return {
          root: this.root, data_dir: this.dataDir,
          model_path: this.modelPath, server_path: this.serverPath,
          model_exists: fs.existsSync(this.modelPath),
          server_exists: fs.existsSync(this.serverPath),
          assets_bytes: this.assetsBytes(), hotkey: this.settings.hotkey,
          ocr_language: this.provider.ocrLanguage,
          capture_scope: this.settings.capture_scope,
          shell_enabled: this.shellEnabled,
          capture_scopes: [...CAPTURE_SCOPES]
        };
      }
      default: throw new Error(`未知命令：${cmd}`);
    }
  }

  /** 手动截屏 → OCR → Brief → 持久草稿 + 图片落库（不建正式笔记）。 */
  async captureToDraft(opts = {}) {
    this.busy = true;
    const t0 = Date.now();
    let frameInfo = { foreground: {} };
    let ocrText = '';
    let ocrLines = [];
    let png = null;
    try {
      this.stats.captures++;
      if (opts.text != null) {
        ocrText = String(opts.text);
        frameInfo = { foreground: opts.foreground ?? { process: 'capture_to_draft', title: '文本注入' } };
      } else {
        this.setPhase('capturing', '截屏中…');
        let snap;
        if (opts.region) {
          snap = await this.win.request('snapRegion', {
            scope: opts.region.scope || 'full', rect: opts.region.rect || null, points: opts.region.points || null
          }, 60000);
        } else {
          snap = opts.snap ?? await this.win.request('snap');
        }
        frameInfo = { ...snap, foreground: opts.snap?.foreground ?? snap.foreground ?? {} };
        // 抓取 PNG 用于图片笔记落库（仅当调用方显式需要图片时）。
        if (opts.with_image !== false) {
          try { png = await this.win.shot(); } catch { png = null; }
        }
        this.setPhase('ocr', 'OCR 中…');
        const r = await this.win.request('ocr', {}, 90000);
        this.stats.ocr_calls++;
        this.stats.last_ocr_ms = Date.now() - t0;
        ocrText = r.text ?? '';
        this.provider.ocrLanguage = r.language ?? '-';
        ocrLines = (ocrText || '').split(/\r?\n/).map((t, i) => ({ id: i + 1, text: t.trim() })).filter((l) => l.text);
      }

      const cleaned = cleanOcrText(ocrText, this.settings.max_ocr_chars);
      const sourceApp = frameInfo.foreground?.process ?? '';
      const windowTitle = frameInfo.foreground?.title ?? '';

      // 生成 Brief（本地模型；失败用抽取式兜底）。
      let brief;
      this.setPhase('summarizing', '总结中…');
      const result = await this.provider.summarize({ text: cleaned, maxChars: this.settings.max_ocr_chars });
      this.stats.summarize_calls++;
      this.stats.last_infer_ms = result.latency_ms ?? null;
      brief = {
        display: (result.summary || '').slice(0, 120),
        key_points: result.keywords ?? [],
        todos: [], decisions: [], entities: [],
        detail: '', insight: '',
        source_refs: [],
        provider: result.provider ?? 'LocalLlama',
        parse_ok: result.parse_ok !== false
      };

      // 写入持久草稿（不建正式笔记）。
      const draft = this.db.createDraft({
        kind: 'manual',
        brief,
        ocr_raw: ocrText,
        ocr_clean: cleaned,
        ocr_lines: ocrLines,
        source_app: sourceApp,
        window_title: windowTitle
      });

      // 图片落库并关联草稿。
      if (png && png.length > 0) {
        const meta = persistAsset(this.dataDir, png);
        const assetId = this.db.addAsset({
          draft_id: draft.id,
          relative_path: meta.relative_path,
          mime: 'image/png',
          width: frameInfo.width ?? 0,
          height: frameInfo.height ?? 0,
          bytes: meta.bytes,
          sha256: meta.sha256
        });
        this.db.linkAssetToDraft(assetId, draft.id);
        draft.asset_id = assetId;
        draft.asset_relative_path = meta.relative_path;
      }

      this.stats.last_total_ms = Date.now() - t0;
      this.setPhase('done', `已生成待归档草稿 #${draft.id}（${this.stats.last_total_ms} ms）`);
      return draft;
    } catch (e) {
      this.setError(e);
      throw e;
    } finally {
      this.busy = false;
      try { await this.win.request('clear'); } catch { /* helper closing */ }
    }
  }

  /** auto 灵感：OCR + Brief，但不写库；结果冻结到 lastAutoInspire 供转正。 */
  async autoInspire(opts = {}) {
    return this._runSerial(() => this._captureWithAutoEvent('auto', { ...opts, forceReply: true }));
  }

  assetsBytes() {
    let total = 0;
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else total += fs.statSync(p).size;
      }
    };
    walk(path.join(this.root, 'assets'));
    return total;
  }

  // ---------------- self test ----------------
  async selftest() {
    const t0 = Date.now();
    const results = [];
    const createdIds = [];
    // Self checks deliberately flip auto mode and the capture scope. Restore
    // the user's real configuration afterwards, otherwise a test run silently
    // changes the next launch (e.g. leaving capture_scope = rect, which makes
    // every later capture wait for a manual drag selection).
    const settingsBefore = JSON.parse(JSON.stringify(this.settings));
    const cloudUnconfigured = this.settings.provider === 'OpenAiCompatible'
      && !this.settings.api_config.api_key;
    const check = async (name, fn) => {
      const start = Date.now();
      try {
        const detail = await fn();
        results.push({ name, ok: true, detail: String(detail), duration_ms: Date.now() - start });
      } catch (e) {
        results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e), duration_ms: Date.now() - start });
      }
    };

    await check('离线资源完整性', () => {
      const isCloud = this.settings.provider === 'OpenAiCompatible';
      if (isCloud) {
        const bytes = this.assetsBytes();
        return `云端模式（本地模型可缺失），资源合计 ${(bytes / 1048576).toFixed(0)} MB`;
      }
      if (!fs.existsSync(this.modelPath)) throw new Error('模型文件缺失');
      const size = fs.statSync(this.modelPath).size;
      if (size !== MODEL_SIZE) throw new Error(`模型大小异常：${size}`);
      if (!fs.existsSync(this.serverPath)) throw new Error('llama-server.exe 缺失');
      const bytes = this.assetsBytes();
      if (bytes > 900 * 1024 * 1024) throw new Error(`资源体积超限：${(bytes / 1048576).toFixed(0)} MB`);
      return `模型 ${(size / 1048576).toFixed(0)} MB，资源合计 ${(bytes / 1048576).toFixed(0)} MB ≤ 900 MB`;
    });

    await check('SQLite + FTS5 中文检索', () => {
      const probe = this.db.insert({
        title: '自检中文检索探针', summary: '全文搜索验证', ocr_text: '屏幕笔记支持中文全文搜索与离线摘要',
        keywords: ['检索'], source_app: 'selftest', window_title: '自检', capture_mode: 'manual',
        latency_ms: 0, provider: 'selftest', parse_ok: true
      });
      createdIds.push(probe.id);
      const hits = this.db.list('中文全文搜索', 20);
      if (!hits.some((n) => n.id === probe.id)) throw new Error('中文关键词未命中 FTS5');
      return `FTS5 命中 ${hits.length} 条（含探针 #${probe.id}）`;
    });

    await check('Windows OCR 中文语言包', async () => {
      const r = await this.win.request('ocrtest', {}, 90000);
      const flat = String(r.text ?? '').replace(/\s+/g, '');
      if (!/屏幕笔记/.test(flat)) throw new Error(`中文识别异常：${r.text}`);
      if (r.language !== 'zh-Hans-CN') throw new Error(`语言包不符：${r.language}`);
      return `zh-Hans-CN 识别「${flat.slice(0, 24)}」`;
    });

    await check('真实截屏（内存，不落盘）', async () => {
      const s = await this.win.request('snap');
      if (!s.width || !s.height || !s.fingerprint) throw new Error('截屏结果为空');
      await this.win.request('clear');
      const pngs = fs.readdirSync(this.dataDir).filter((f) => /\.(png|jpg|bmp)$/i.test(f));
      if (pngs.length) throw new Error(`发现落盘截图：${pngs.join(',')}`);
      return `${s.width}×${s.height}，指纹 ${s.fingerprint.length / 2} 像素，前台 ${s.foreground?.process || '未知'}，无截图落盘`;
    });

    await check('提供方健康检查', async () => {
      if (cloudUnconfigured) return '未配置文本 API Key，跳过云端检查；截图使用抽取式摘要';
      const a = await this.provider.ensureStarted();
      const health = await this.provider.healthCheck();
      if (!health.ok) throw new Error(health.detail);
      const b = await this.provider.ensureStarted();
      if (this.settings.provider === 'LocalLlama') {
        if (a.port !== b.port || a.load_ms !== b.load_ms) throw new Error('模型被重复加载');
        return `端口 ${a.port}，首次加载 ${a.load_ms} ms，复用同一进程`;
      }
      return `云端就绪：${this.settings.api_config.base_url} / ${this.settings.api_config.model}`;
    });

    await check('模型推理与三段解析', async () => {
      if (this.settings.provider === 'OpenAiCompatible') {
        const hc = await this.provider.healthCheck();
        if (!hc.ok) return `云端未配置（${hc.detail}），跳过真实推理`;
        return `云端已就绪，推理在首次记录时按需调用（${this.settings.api_config.model}）`;
      }
      const r = await this.provider.summarize({ text: '屏幕笔记项目周会：确定离线 Demo 范围，先完成手动记录，再补自动记录，最后打包 Windows 安装包。张三负责 OCR，李四负责模型常驻。', maxChars: 600 });
      if (!r.title || !r.summary) throw new Error(`模型输出无效：${JSON.stringify(r)}`);
      if (r.error) throw new Error(r.error);
      return `标题「${r.title}」，摘要 ${r.summary.length} 字，关键词 ${(r.keywords || []).length} 个，推理 ${r.latency_ms} ms`;
    });

    await check('格式不完整时仍保留笔记', () => {
      const p = parseSummary('标题：测试标题\n摘要：\n关键词：', '屏幕笔记项目周会 确定离线 Demo 范围 先完成手动记录 再补自动记录');
      if (!p.title || !p.summary || p.parse_ok !== false) throw new Error('兜底解析失败');
      return `parse_ok=false，仍生成标题「${p.title}」和 ${p.summary.length} 字摘要`;
    });

    await check('手动闭环（截屏→OCR→总结→保存）', async () => {
      const n = await this.captureOnce('manual', {});
      if (!n || n.skipped || !n.id || !n.ocr_text) throw new Error('未生成完整笔记');
      createdIds.push(n.id);
      // 屏幕内容是任意的（可能是乱码/英文长串），取前 N 字做关键词会因 FTS
      // 整词 token 边界而失配。这里改为验证「该笔记确实写入了 FTS 索引」，
      // 这才是本项要证明的「保存后可检索」；检索命中能力由上一项中文探针覆盖。
      const indexed = this.db.db.prepare('SELECT rowid FROM notes_fts WHERE rowid = ?').get(n.id);
      if (!this.db.get(n.id) || !indexed) throw new Error('保存后未写入检索索引');
      return `笔记 #${n.id}，OCR ${n.ocr_text.length} 字，耗时 ${n.latency_ms} ms，模式 ${n.capture_mode}，FTS 已索引`;
    });

    await check('编辑、Markdown 导出', async () => {
      const n = await this.captureOnce('manual', {
        text: '导出验证：这条笔记用于检查标题摘要编辑、Markdown 导出和全文搜索是否正常工作。',
        foreground: { process: 'selftest', title: '导出验证窗口' }
      });
      createdIds.push(n.id);
      const edited = this.db.update(n.id, '自检编辑后的标题', '自检编辑后的摘要');
      if (edited.title !== '自检编辑后的标题') throw new Error('编辑未生效');
      const md = this.db.toMarkdown(edited);
      if (!md.includes('# 自检编辑后的标题') || !md.includes('## OCR 原文') || !md.includes('```text')) throw new Error('Markdown 结构异常');
      return `编辑生效，Markdown ${md.length} 字符，含摘要/OCR 原文`;
    });

    await check('OCR 文本去重（无变化不重复建笔记）', async () => {
      const before = this.db.count();
      await this.captureOnce('auto', { text: '去重验证：同一段屏幕文字连续出现时应跳过总结，不产生重复笔记。', foreground: { process: 'dedup', title: '去重窗口' } });
      const mid = this.db.count();
      const second = await this.captureOnce('auto', { text: '去重验证：同一段屏幕文字连续出现时应跳过总结，不产生重复笔记。', foreground: { process: 'dedup', title: '去重窗口' } });
      createdIds.push(...this.db.list('', 50).filter((n) => n.source_app === 'dedup').map((n) => n.id));
      if (mid !== before) throw new Error('陪伴不应自动创建笔记');
      if (!second?.skipped) throw new Error('相同 OCR 文本未被跳过');
      return `首次生成灵感不落库，重复文本跳过（skipped_no_change=${this.stats.skipped_no_change}）`;
    });

    await check('陪伴灵感不自动保存、主动收藏幂等', async () => {
      if (cloudUnconfigured) return '未配置文本 API Key，跳过需要云端回应的收藏自检';
      const before = this.db.count();
      const fg = { process: 'browser', title: '屏幕笔记项目讨论 - 浏览器' };
      if (this.isSelfForeground(fg)) throw new Error('项目名导致前台误判');
      const a = await this.captureOnce('auto', { text: '陪伴测试第一段：今天正在阅读设计方案，页面讨论如何减少用户操作。', foreground: fg });
      const b = await this.captureOnce('auto', { text: '完全不同的新页面，讨论音频端点检测与字幕排版的可读性。', foreground: fg });
      if (!a.id || !b.id || a.id === b.id || this.db.count() !== before) throw new Error('陪伴灵感被自动写入了笔记');
      const saved = await this.dispatch('collect_inspire', { id: a.id });
      createdIds.push(saved.id);
      const again = await this.dispatch('collect_inspire', { id: a.id });
      if (saved.id !== again.id || this.db.count() !== before + 1) throw new Error('主动收藏重复建笔记');
      return '页面灵感不落库，主动收藏一次，同名项目窗口不再误判';
    });

    await check('自动模式开关与状态', async () => {
      await this.dispatch('set_auto_mode', { enabled: true });
      if (!this.status.auto_enabled || !this.autoTimer) throw new Error('自动模式未开启');
      await this.dispatch('set_auto_mode', { enabled: false });
      if (this.status.auto_enabled || this.autoTimer) throw new Error('自动模式未暂停');
      return '开启/暂停状态正确，定时任务已清理';
    });

    await check('默认手动模式与两种截屏范围', async () => {
      if (this.settings.auto_enabled) throw new Error('启动默认不是手动模式');
      const prev = this.settings.capture_scope;
      for (const s of ['rect', 'full']) {
        const r = await this.dispatch('set_capture_scope', { scope: s });
        if (r.capture_scope !== s) throw new Error(`范围未生效：${s}`);
      }
      await this.dispatch('set_capture_scope', { scope: prev });
      let rejected = false;
      try { await this.dispatch('set_capture_scope', { scope: 'bogus' }); } catch { rejected = true; }
      if (!rejected) throw new Error('非法范围未被拒绝');
      return `启动为手动模式，full / rect 均可切换，非法值被拒绝`;
    });

    await check('悬浮窗命令队列与状态快照', async () => {
      const was = this.shellEnabled;
      this.setShellEnabled(true);
      try {
        this.queueShellCommand({ type: 'capture', scope: 'rect' });
        const poll = await this.dispatch('shell_poll', {});
        if (!poll.commands?.some((c) => c.type === 'capture' && c.scope === 'rect')) throw new Error('命令未入队');
        const again = await this.dispatch('shell_poll', {});
        if (again.commands?.length) throw new Error('队列未清空');
        const state = await this.dispatch('get_shell_state', {});
        if (!CAPTURE_SCOPES.has(state.scope) || state.auto_enabled !== false) throw new Error('状态快照异常');
        return `命令可取走且不重复，状态 scope=${state.scope} auto=${state.auto_enabled}`;
      } finally {
        this.setShellEnabled(was);
      }
    });

    await check('矩形区域截屏（不落盘）', async () => {
      const rect = { x: 60, y: 60, w: 900, h: 480 };
      const a = await this.win.request('snapRegion', { scope: 'rect', rect, points: null }, 60000);
      if (a.width !== 900 || a.height !== 480) throw new Error(`矩形尺寸异常 ${a.width}×${a.height}`);

      const ocr = await this.win.request('ocr', {}, 90000);
      await this.win.request('clear');
      if (!a.fingerprint) throw new Error('区域指纹缺失');
      return `矩形 900×480，裁剪后 OCR ${String(ocr.text).length} 字`;
    });

    await check('笔记分区与按分区检索', async () => {
      const n = await this.captureOnce('manual', {
        text: '分区验证：这条笔记用于检查笔记分区的创建、移动以及按分区过滤检索是否正常工作。',
        foreground: { process: 'selftest', title: '分区验证窗口' }
      });
      createdIds.push(n.id);
      if (n.section !== DEFAULT_SECTION_MANUAL) throw new Error(`默认分区错误：${n.section}`);
      const moved = this.db.setSection(n.id, '工作');
      if (moved.section !== '工作') throw new Error('分区移动失败');
      const hits = this.db.list('', 50, '工作');
      if (!hits.some((x) => x.id === n.id)) throw new Error('按分区过滤未命中');
      const secs = this.db.listSections();
      if (!secs.some((s) => s.name === '工作')) throw new Error('分区列表缺少新分区');
      const md = this.db.toMarkdown(moved);
      if (!md.includes('> 分区：工作')) throw new Error('导出的 Markdown 缺少分区');
      return `默认「${DEFAULT_SECTION_MANUAL}」→「工作」，过滤命中 ${hits.length} 条，共 ${secs.length} 个分区`;
    });

    await check('配置持久化', () => {
      this.saveSettings();
      const raw = fs.readFileSync(this.settingsPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed.provider !== this.settings.provider) throw new Error('提供方配置错误');
      if (parsed.api_config?.base_url !== this.settings.api_config.base_url) throw new Error('API base_url 未持久化');
      return `settings.json 已保存，provider=${parsed.provider}，base_url=${parsed.api_config.base_url}`;
    });

    for (const id of [...new Set(createdIds)]) {
      try { this.db.delete(id); } catch { /* ignore */ }
    }
    // Leave settings.json exactly as we found it.
    this.settings = settingsBefore;
    this.settings.data_dir = this.dataDir;
    try { this.saveSettings(); } catch { /* diagnostic only */ }
    this.stopAuto();
    this.stats.notes_count = this.db.count();
    this.lastOcrHash = '';
    this.setPhase('idle', '自检完成');
    return {
      passed: results.every((r) => r.ok),
      results,
      elapsed_ms: Date.now() - t0
    };
  }

  shutdown() {
    this._captionControl?.cancel();
    this.localAsrComponents.disposeWarmWorker();
    this.stopAuto();
    this._stopAudioCapture();
    this.provider.stop();
    this.win.close();
    this.db.close();
    this.initialized = false;
  }

  /** 停止系统音频采集（幂等）。 */
  _stopAudioCapture() {
    if (this.audioCapture) {
      try { this.audioCapture.stop(); } catch { /* ignore */ }
      this.audioCapture = null;
    }
  }

  /** 把笔记的图片复制到分区指定文件夹（幂等，失败不阻断提交）。 */
  _copyAssetsToSectionFolder(noteId, folderPath) {
    try {
      const assets = this.db.listAssets(noteId, null);
      if (!assets.length || !folderPath) return 0;
      fs.mkdirSync(folderPath, { recursive: true });
      let copied = 0;
      for (const a of assets) {
        const src = path.join(this.dataDir, a.relative_path);
        if (!fs.existsSync(src)) continue;
        const dest = path.join(folderPath, path.basename(a.relative_path));
        fs.copyFileSync(src, dest);
        copied++;
      }
      return copied;
    } catch (e) {
      this.status.last_error = `复制图片到分区文件夹失败：${e.message}`;
      return 0;
    }
  }

  /**
   * 启动本地 whisper 转写循环：周期读取音频缓冲 → 转写 → 写入字幕会话。
   * 每次处理「自上次处理以来新增」的 PCM 窗口，非 final 结果也落库（供实时预览）。
   * 串行化：转写是 CPU 密集且进程内单例，上一轮未完成不启动下一轮。
   */
  _captionFor(args) {
    if (args.session_id == null || Number(args.session_id) === this.captionSession?.id) {
      if (!this.captionSession) throw new Error('字幕会话未开始');
      return this.captionSession;
    }
    const row = this.db.db.prepare('SELECT * FROM caption_sessions WHERE id = ?').get(Number(args.session_id));
    if (!row || !['review', 'recording'].includes(row.status)) throw new Error('字幕会话不存在或已处理');
    const session = new CaptionSession(this.db, { source: row.source, provider: row.provider });
    session.id = Number(row.id);
    return session;
  }

  captionProvider(requested = 'OpenAiCompatibleASR') {
    if (requested !== 'OpenAiCompatibleASR') return requested;
    const mode = this.settings.caption_engine;
    const chinese = /^zh(?:[-_]|$)/i.test(this.settings.asr_config?.language ?? '');
    if (mode === 'local' || (mode === 'auto' && chinese && this.localAsrComponents.status().ready)) {
      return 'LocalStreamingASR';
    }
    return requested;
  }

  async _drainCaption() {
    if (this.audioCapture) {
      if (this._captionAudioHandler) this.audioCapture.removeListener('data', this._captionAudioHandler);
      this.audioCapture.stop();
    }
    this._captionSegmenter?.finish();
    if (this._captionControl) await this._captionControl.drain();
  }

  async _startCaptionTranscribeLoop() {
    if (this._captionSegmenter || this._captionAudioHandler) return;
    const session=this.captionSession, provider=this.asrProvider, audio=this.audioCapture;
    this._captionControl?.cancel();
    if(provider.name==='LocalStreamingASR') {
      this.status.message='正在加载本地识别模型…';
      this._captionControl=new StreamingCaptionController({session,components:this.localAsrComponents,onIssue:e=>{this.status.last_error=e.message;},onPressure:()=>this.audioCapture?.stop()});
      await this._captionControl.start();
      this._captionAudioHandler=chunk=>this._captionControl.push(chunk);audio?.on('data',this._captionAudioHandler);
      if (audio?.bytesCaptured) this._captionControl.push(audio.readRecent(Infinity));
      return;
    }
    this._captionControl=new CaptionController({session,provider,concurrency:this.settings.caption_processing?.concurrency ?? 2,
      onIssue:e=>{this.status.last_error=e.message;this.status.message='部分字幕未能识别，可重试失败片段';},
      onPressure:()=>{this.audioCapture?.stop();this.status.message='音频积压达到上限，采集已暂停，请先处理已有内容';}});
    const fast=this.settings.caption_processing?.profile==='fast';
    this._captionSegmenter = new SpeechSegmenter(segment => {
      this._captionControl.enqueue(segment);
    },{pauseMs:fast?240:280,maxMs:fast?1800:2200,firstMaxMs:fast?1100:1400,firstPauseAfterMs:900});
    this._captionAudioHandler = chunk => this._captionSegmenter?.push(chunk);
    audio?.on('data', this._captionAudioHandler);
    if (audio?.bytesCaptured) this._captionSegmenter.push(audio.readRecent(Infinity));
  }

  /** 停止转写循环（幂等）。 */
  _stopCaptionTranscribeLoop() {
    if (this.audioCapture && this._captionAudioHandler) this.audioCapture.removeListener('data', this._captionAudioHandler);
    this._captionSegmenter = null;
    this._captionAudioHandler = null;
    if (this._captionTranscribeTimer) {
      clearInterval(this._captionTranscribeTimer);
      this._captionTranscribeTimer = null;
    }
    if (this.asrProvider?.stop) this.asrProvider.stop();
  }
}
