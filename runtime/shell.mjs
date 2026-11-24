/** Launches the native WinForms shell: mini panel, tray icon and capture overlays. */
import { spawn } from 'node:child_process';
import path from 'node:path';

export function startShell({ root, port, smoke = false, onLog = () => {} }) {
  const ps1 = path.join(root, 'runtime', 'win-shell.ps1');
  const icon = path.join(root, 'runtime', 'icon.ico');
  const args = [
    '-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass',
    '-File', ps1, '-Port', String(port), '-IconPath', icon
  ];
  if (smoke) args.push('-Smoke');
  const proc = spawn('powershell.exe', args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let pending = '';
  proc.stdout.on('data', (d) => {
    pending += d.toString();
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) onLog('shell', line.trim());
  });
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });
  proc.on('error', (e) => onLog('shell-error', e.message));
  return { proc, getStderr: () => stderr };
}
