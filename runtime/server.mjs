/** Local HTTP runtime: serves the built Svelte UI and the unified command API. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ScreenNotesCore } from './core.mjs';
import { root, preferredPort, portRange, identity } from './instance.mjs';
import { openMainWindow } from './open-main.mjs';

const distDir = path.join(root, 'dist');

/** Bind the first free port starting at `start`, so an occupied port never aborts startup. */
export async function listenWithFallback(server, start) {
  let lastError;
  for (let p = start; p < start + portRange; p++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (e) => {
          server.removeListener('listening', onListening);
          reject(e);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(p, '127.0.0.1');
      });
      return p;
    } catch (e) {
      lastError = e;
      if (e?.code !== 'EADDRINUSE') throw e;
      if (p === start) console.warn(`端口 ${p} 被占用，正在尝试其他端口…`);
    }
  }
  throw lastError ?? new Error('没有可用端口');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json'
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(distDir, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(distDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    if (rel === '/index.html' && !fs.existsSync(distDir)) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('前端尚未构建，请先运行 npm install && npm run build');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
    return;
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(body);
}

const wantShell =
  process.argv.includes('--shell') && process.env.SCREEN_NOTES_SHELL !== '0';
const shellSmoke = process.argv.includes('--shell-smoke');

export async function startServer({ open = false } = {}) {
  const core = new ScreenNotesCore({ root });
  core.setShellEnabled(wantShell);
  await core.init();
  let shellProc = null;
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'POST' && url.startsWith('/api/')) {
      const cmd = url.slice(5).split('?')[0];
      let raw = '';
      req.on('data', (d) => {
        raw += d;
        if (raw.length > 2_000_000) req.destroy();
      });
      req.on('end', async () => {
        let args = {};
        try { args = raw ? JSON.parse(raw) : {}; } catch { return sendJson(res, 400, { error: 'JSON 解析失败' }); }
        try {
          const data = await core.dispatch(cmd, args);
          sendJson(res, 200, { data });
        } catch (e) {
          sendJson(res, 200, { error: e instanceof Error ? e.message : String(e) });
        }
      });
      return;
    }
    if (req.method === 'GET' && url === '/api/_health') return sendJson(res, 200, { data: { ok: true, backend: 'node', shell: wantShell, ...identity } });
    // 图片资产静态服务：只允许 data/assets/ 内的相对路径，防路径穿越。
    if (req.method === 'GET' && url.startsWith('/api/asset')) {
      const q = new URL(url, 'http://localhost').searchParams.get('path') ?? '';
      const rel = path.normalize(q).replace(/^([/\\])+/, '').replace(/\\/g, '/');
      const assetsRoot = path.resolve(core.dataDir, 'assets');
      const file = path.resolve(core.dataDir, rel);
      if (!file.startsWith(assetsRoot) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404');
        return;
      }
      const body = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'image/png', 'Cache-Control': 'no-cache' });
      res.end(body);
      return;
    }
    serveStatic(req, res, url);
  });

  const port = await listenWithFallback(server, preferredPort);

  let shuttingDown = false;
  const cleanup = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { core.shutdown(); } catch { /* ignore */ }
    if (shellProc && !shellProc.killed) {
      try { shellProc.kill(); } catch { /* already gone */ }
    }
    server.close();
  };
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });

  console.log(`屏幕笔记本地服务已启动: http://127.0.0.1:${port}`);
  console.log(`数据目录: ${core.dataDir}`);
  console.log(`模型: ${core.modelPath}`);

  try {
    fs.writeFileSync(
      path.join(core.dataDir, 'runtime.json'),
      JSON.stringify({ port, pid: process.pid, started_at: Date.now(), shell: wantShell }, null, 2),
      'utf8'
    );
  } catch { /* diagnostic file only */ }

  if (wantShell) {
    const { startShell } = await import('./shell.mjs');
    const sh = startShell({
      root,
      port,
      smoke: shellSmoke,
      onLog: (kind, msg) => console.log(`[${kind}] ${msg}`)
    });
    shellProc = sh.proc;
    sh.proc.on('exit', (code) => {
      const shellErr = sh.getStderr?.()?.trim();
      if (shellErr) console.error(`[shell-stderr] ${shellErr.slice(-2500)}`);
      console.log(`原生悬浮窗已退出 (code ${code})，服务随之关闭`);
      cleanup();
      process.exit(0);
    });
  }

  if (open && process.env.SCREEN_NOTES_NO_OPEN !== '1') {
    if (wantShell) core.queueShellCommand({ type: 'open_main' });
    else openMainWindow(port);
  }
  return { server, core, port, shellProc };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('server.mjs')) {
  startServer({ open: process.argv.includes('--open') }).catch((e) => {
    console.error('启动失败:', e);
    process.exit(1);
  });
}
