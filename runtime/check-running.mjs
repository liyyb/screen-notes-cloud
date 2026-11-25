/**
 * Reuse an already-running Screen Notes instance instead of starting a second one.
 * Exit 0 = reused this build, 1 = no matching instance, 2 = data directory in use.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, preferredPort, portRange, identity } from './instance.mjs';
import { openMainWindow } from './open-main.mjs';

let recordedPort;
try {
  const recorded = JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime.json'), 'utf8'));
  if (Number.isInteger(recorded.pid) && recorded.pid > 0 &&
      Number.isInteger(recorded.port) && recorded.port > 0 && recorded.port <= 65535) {
    process.kill(recorded.pid, 0);
    recordedPort = recorded.port;
  }
} catch { /* absent or stale runtime record */ }

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/_health', timeout: 900 },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          let health = null;
          try {
            if (res.statusCode === 200) health = JSON.parse(body).data;
          } catch {
            /* not our service */
          }
          resolve(health);
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

const ports = new Set(Array.from({ length: portRange }, (_, i) => preferredPort + i));
if (recordedPort) ports.add(recordedPort);
const instances = await Promise.all([...ports].map(async port => [port, await probe(port)]));
for (const [port, health] of instances) {
  if (!health?.ok) continue;
  if (Object.entries(identity).every(([key, value]) => health[key] === value)) {
    const url = `http://127.0.0.1:${port}/?view=main`;
    console.log(`Screen Notes is already running: ${url}`);
    if (process.env.SCREEN_NOTES_NO_OPEN !== '1') {
      if (health.shell) {
        const response = await fetch(`http://127.0.0.1:${port}/api/open_main_window`, { method: 'POST', signal: AbortSignal.timeout(2500) });
        if (!response.ok) throw new Error('无法激活笔记库窗口');
      } else openMainWindow(port);
    }
    process.exit(0);
  }
  if ((health.product === identity.product && health.data_id === identity.data_id) ||
      (!health.product && port === recordedPort && health.backend === 'node')) {
    console.error('已有另一版本正在使用此数据目录。请从其托盘菜单退出后重启。');
    process.exit(2);
  }
}
process.exit(1);
