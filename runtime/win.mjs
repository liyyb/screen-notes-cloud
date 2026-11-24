/** Windows system layer wrapper: GDI capture, Windows.Media.Ocr, global hotkey. */
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HELPER = path.join(here, 'win-helper.ps1');

function psArgs(mode, extra = []) {
  return [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', DEFAULT_HELPER, '-Mode', mode, ...extra
  ];
}

export class WindowsHelper extends EventEmitter {
  constructor(timeoutMs = 60000) {
    super();
    this.timeoutMs = timeoutMs;
    this.screen = null;
    this.hotkeyProc = null;
    this.ready = false;
    this.pending = null;
    this.queue = [];
    this.stderr = '';
    this.hotkeyShortcut = null;
    this.hotkeyError = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      if (this.screen) return resolve();
      const proc = spawn('powershell.exe', psArgs('screen'), {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      this.screen = proc;
      const timer = setTimeout(() => reject(new Error('Windows helper 启动超时')), 20000);
      const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
      rl.on('line', (line) => {
        let obj;
        try { obj = JSON.parse(line); } catch { this.emit('log', line); return; }
        if (obj.event === 'ready' && !this.ready) {
          this.ready = true;
          clearTimeout(timer);
          this.pump();
          resolve();
          return;
        }
        if (this.pending && typeof obj.ok === 'boolean') {
          const item = this.pending;
          this.pending = null;
          clearTimeout(item.timer);
          if (obj.ok) item.resolve(obj);
          else item.reject(new Error(obj.error || 'Windows helper error'));
          this.pump();
        } else {
          this.emit('event', obj);
        }
      });
      proc.stderr.on('data', (d) => {
        this.stderr = (this.stderr + d.toString()).slice(-4000);
        this.emit('log', d.toString().trim());
      });
      proc.on('exit', (code) => {
        this.ready = false;
        clearTimeout(timer);
        if (this.pending) {
          clearTimeout(this.pending.timer);
          this.pending.reject(new Error(`Windows helper 已退出 (code ${code})`));
          this.pending = null;
        }
        this.screen = null;
        this.emit('exit', code);
      });
    });
  }

  pump() {
    if (!this.ready || this.pending || this.queue.length === 0 || !this.screen) return;
    const item = this.queue.shift();
    this.pending = item;
    item.timer = setTimeout(() => {
      if (this.pending === item) {
        this.pending = null;
        item.reject(new Error(`Windows helper 命令超时: ${item.cmd}`));
        this.pump();
      }
    }, item.timeoutMs ?? this.timeoutMs);
    try {
      this.screen.stdin.write(JSON.stringify({ cmd: item.cmd, ...item.extra }) + '\n');
    } catch (e) {
      clearTimeout(item.timer);
      this.pending = null;
      item.reject(e);
      this.pump();
    }
  }

  request(cmd, extra = {}, timeoutMs) {
    return new Promise((resolve, reject) => {
      this.queue.push({ cmd, extra, resolve, reject, timeoutMs });
      this.pump();
    });
  }

  /**
   * 获取当前已抓取帧的 PNG（base64 解码为 Buffer）。
   * 截图数据仍在 helper 内存中；仅用于显式保存图片笔记时落库，不自动落盘。
   */
  async shot() {
    const r = await this.request('shot', {}, 30000);
    if (!r?.png) return null;
    return Buffer.from(r.png, 'base64');
  }

  /** 弹系统文件夹选择对话框，返回绝对路径（取消返回空串）。 */
  async pickFolder(initial = '') {
    const r = await this.request('pickfolder', { initial }, 120000);
    return r?.path ?? '';
  }

  setHotkey(shortcut) {
    this.stopHotkey();
    this.hotkeyShortcut = shortcut;
    this.hotkeyError = null;
    const proc = spawn('powershell.exe', psArgs('hotkey', ['-Shortcut', shortcut]), {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    this.hotkeyProc = proc;
    const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      let obj;
      try { obj = JSON.parse(line); } catch { return; }
      if (obj.event === 'hotkey') this.emit('hotkey', obj);
      else if (obj.event === 'error') {
        this.hotkeyError = obj.message;
        this.emit('hotkey-error', obj.message);
      } else if (obj.event === 'ready') this.emit('hotkey-ready', obj);
    });
    let err = '';
    proc.stderr.on('data', (d) => (err = (err + d.toString()).slice(-2000)));
    proc.on('exit', (code) => {
      if (this.hotkeyProc === proc) this.hotkeyProc = null;
      if (code !== 0 && !this.hotkeyError) this.emit('hotkey-error', err || `hotkey worker exited ${code}`);
    });
  }

  stopHotkey() {
    if (this.hotkeyProc) {
      try { this.hotkeyProc.kill(); } catch { /* already gone */ }
      this.hotkeyProc = null;
    }
  }

  close() {
    this.stopHotkey();
    if (this.screen) {
      try { this.screen.stdin.write('{"cmd":"clear"}\n'); } catch { /* ignore */ }
      try { this.screen.kill(); } catch { /* ignore */ }
      this.screen = null;
    }
    this.ready = false;
  }
}

export function openFolder(folder) {
  const proc = spawn('explorer.exe', [folder], { windowsHide: false, stdio: 'ignore', detached: true });
  proc.unref();
  return folder;
}
