/**
 * Reuse an already-running Screen Notes instance instead of starting a second one.
 * Exit 0 = found an instance (and opened its window), exit 1 = none running.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BASE = Number(process.env.SCREEN_NOTES_PORT ?? 17860);
const RANGE = 12;

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/_health', timeout: 900 },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          let ok = false;
          try {
            ok = Boolean(JSON.parse(body).data?.ok);
          } catch {
            /* not our service */
          }
          resolve(ok);
        });
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function openWindow(url) {
  if (process.env.SCREEN_NOTES_NO_OPEN === '1') return;
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ];
  const edge = candidates.find((p) => p && fs.existsSync(p));
  if (edge) {
    spawn(edge, [`--app=${url}`, '--window-size=1200,800'], { stdio: 'ignore', detached: true }).unref();
  } else {
    spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
  }
}

for (let port = BASE; port < BASE + RANGE; port++) {
  if (await probe(port)) {
    const url = `http://127.0.0.1:${port}/?view=main`;
    console.log(`Screen Notes is already running: ${url}`);
    openWindow(url);
    process.exit(0);
  }
}
process.exit(1);
