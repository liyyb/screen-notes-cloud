/**
 * 系统音频回环采集（复用 huxinhai/audio_capture 预编译二进制）。
 *
 * 采集「电脑正在播放的声音」（WASAPI loopback），重采样为 16 kHz 单声道 16-bit PCM，
 * 通过 stdout 流出；本模块只把 PCM 放入内存环形缓冲，音频本身绝不落盘。
 *
 * 依赖：tools/audio_capture.exe（24 KB，无运行时依赖，Windows x64 预编译）。
 * 不可用时抛出 AGGREGATE 错误，由调用方降级到云端 ASR 或明确提示「音频不可用」。
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ContractError } from '../contracts/errors.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export const AUDIO_DEFAULTS = {
  sampleRate: 16000,
  channels: 1,
  bitDepth: 16,
  chunkDuration: 0.1,
  // 每样本字节数（16-bit = 2 字节）。
  bytesPerSample: 2,
  // 环形缓冲上限（约 30 秒 PCM），防止内存无限增长。
  maxBufferBytes: 16000 * 2 * 30
};

/**
 * 定位 audio_capture 二进制。
 * 顺序：项目 tools/ 目录 → 环境变量 SCREEN_NOTES_AUDIO_CAPTURE → PATH。
 */
export function locateAudioCapture(rootDir) {
  const candidates = [];
  if (rootDir) candidates.push(path.join(rootDir, 'tools', 'audio_capture.exe'));
  if (process.env.SCREEN_NOTES_AUDIO_CAPTURE) candidates.push(process.env.SCREEN_NOTES_AUDIO_CAPTURE);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * 系统音频采集器。
 * 事件：
 *   'data'   (chunk: Buffer)  每次收到一段 16k mono s16le PCM
 *   'level'  ({ rms: number }) 每次粗略音量（用于 UI 电平）
 *   'error'  (Error)          进程异常/退出
 *   'close'  (code)           进程退出
 */
export class SystemAudioCapture extends EventEmitter {
  constructor(binPath, opts = {}) {
    super();
    this.binPath = binPath;
    this.source = opts.source ?? 'loopback';
    this.sampleRate = opts.sampleRate ?? AUDIO_DEFAULTS.sampleRate;
    this.channels = opts.channels ?? AUDIO_DEFAULTS.channels;
    this.bitDepth = opts.bitDepth ?? AUDIO_DEFAULTS.bitDepth;
    this.chunkDuration = opts.chunkDuration ?? AUDIO_DEFAULTS.chunkDuration;
    this.maxBufferBytes = opts.maxBufferBytes ?? AUDIO_DEFAULTS.maxBufferBytes;
    this.proc = null;
    this.ring = Buffer.alloc(this.maxBufferBytes);
    this.writeOffset = 0;
    this.running = false;
    this.bytesCaptured = 0;
  }

  /** 是否可用（二进制存在且能启动）。 */
  get available() {
    return this.source === 'microphone' ? fs.existsSync(path.join(here,'mic-capture.ps1')) : !!this.binPath && fs.existsSync(this.binPath);
  }

  /**
   * 开始采集。返回 this。
   * 失败（缺二进制/启动失败）抛 ContractError('AUDIO_UNAVAILABLE')。
   */
  start() {
    if (this.running) return this;
    if (!this.available) {
      throw new ContractError('AUDIO_UNAVAILABLE', '系统音频采集组件缺失，无法录制系统声音');
    }
    const args = [
      '--sample-rate', String(this.sampleRate),
      '--channels', String(this.channels),
      '--bit-depth', String(this.bitDepth),
      '--chunk-duration', String(this.chunkDuration)
    ];
    const microphone = this.source === 'microphone';
    this.proc = spawn(microphone ? 'powershell.exe' : this.binPath, microphone ? ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(here,'mic-capture.ps1')] : args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.running = true;
    let errText = '';
    this.proc.stdout.on('data', (d) => this._onChunk(d));
    this.proc.stderr.on('data', (d) => (errText = (errText + d.toString()).slice(-2000)));
    this.proc.on('error', (e) => {
      this.running = false;
      this.emit('error', new ContractError('AUDIO_UNAVAILABLE', `音频采集启动失败：${e.message}`));
    });
    this.proc.on('exit', (code) => {
      this.running = false;
      this.emit('close', code);
      if (code !== 0 && code != null) {
        this.emit('error', new ContractError('AUDIO_UNAVAILABLE', `音频采集进程退出 (code ${code}) ${errText.slice(-200)}`));
      }
    });
    return this;
  }

  waitUntilReady(timeoutMs = 6000) {
    if (this.bytesCaptured > 0 && this.running) return Promise.resolve();
    return new Promise((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);this.off('data',ok);this.off('error',fail);this.off('close',closed);};
      const ok=()=>{cleanup();resolve();};const fail=e=>{cleanup();reject(e);};
      const closed=()=>fail(new Error('音频采集未能启动，请检查默认设备和 Windows 权限'));
      const timer=setTimeout(()=>fail(new Error('未收到音频数据，请检查默认设备和 Windows 权限')),timeoutMs);
      this.once('data',ok);this.once('error',fail);this.once('close',closed);
    });
  }

  _onChunk(chunk) {
    this.bytesCaptured += chunk.length;
    // 追加到内存环形缓冲，超出上限时丢弃最旧部分（音频不落盘，只保留最近窗口）。
    const tail = chunk.subarray(Math.max(0, chunk.length - this.ring.length));
    const first = Math.min(tail.length, this.ring.length - this.writeOffset);
    tail.copy(this.ring, this.writeOffset, 0, first);
    tail.copy(this.ring, 0, first);
    this.writeOffset = (this.writeOffset + tail.length) % this.ring.length;
    this.emit('data', chunk);
    if (this.listenerCount('level') === 0) return;
    // 粗略电平（RMS 归一化到 0..1）。
    let rms = 0;
    if (chunk.length >= 2) {
      let sum = 0, n = 0;
      for (let i = 0; i + 1 < chunk.length; i += 2) {
        const v = chunk.readInt16LE(i) / 32768;
        sum += v * v; n++;
      }
      rms = n ? Math.sqrt(sum / n) : 0;
    }
    this.emit('level', { rms });
  }

  /** 读取最近 N 毫秒 PCM（用于「记录这段」时间窗），不消费缓冲。 */
  readRecent(ms) {
    const requested = Math.floor(ms / 1000 * this.sampleRate) * AUDIO_DEFAULTS.bytesPerSample;
    const size = Math.min(this.bytesCaptured, this.ring.length, Math.max(0, requested || 0));
    const start = (this.writeOffset + this.ring.length - size) % this.ring.length;
    const first = Math.min(size, this.ring.length - start);
    const result = Buffer.allocUnsafe(size);
    this.ring.copy(result, 0, start, start + first);
    this.ring.copy(result, first, 0, size - first);
    return result;
  }

  /** 停止采集。 */
  stop() {
    this.running = false;
    if (this.proc) {
      try { this.proc.kill(); } catch { /* already gone */ }
      this.proc = null;
    }
  }
}

/** 导出模块内使用的常量，方便测试。 */
export const _AUDIO = { AUDIO_DEFAULTS, locateAudioCapture, SystemAudioCapture };
