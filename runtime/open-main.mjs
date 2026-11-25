import { spawn } from 'node:child_process';
import path from 'node:path';
import { root } from './instance.mjs';

export function openMainWindow(port) {
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(root, 'runtime', 'main-window.ps1'), '-StandalonePort', String(port)
  ], { windowsHide: true, stdio: 'ignore' });
  child.unref();
}
