/** Command line entry: selftest / capture / notes / config / serve. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ScreenNotesCore } from './core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'selftest';
const asJson = argv.includes('--json');

function out(label, value) {
  if (asJson) return;
  console.log(label, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

async function withCore(fn) {
  const core = new ScreenNotesCore({ root });
  try {
    await core.init({ hotkey: false });
    return await fn(core);
  } finally {
    core.shutdown();
  }
}

async function main() {
  if (cmd === 'serve') {
    const { startServer } = await import('./server.mjs');
    await startServer({ open: argv.includes('--open') });
    return; // keeps running
  }

  const result = await withCore(async (core) => {
    switch (cmd) {
      case 'selftest': return { kind: 'report', value: await core.selftest() };
      case 'config': return { kind: 'config', value: await core.dispatch('get_config', {}) };
      case 'capture': return { kind: 'note', value: await core.dispatch('capture_manual', {}) };
      case 'capture-text': return { kind: 'note', value: await core.dispatch('capture_with_text', { text: argv[1] ?? '屏幕笔记 CLI 文本注入测试：验证总结、保存与检索流程。' }) };
      case 'notes': return { kind: 'notes', value: await core.dispatch('get_notes', { query: argv[1] ?? '' }) };
      case 'clear': return { kind: 'clear', value: await core.dispatch('clear_notes', {}) };
      case 'start-model': return { kind: 'provider', value: await core.dispatch('start_model', {}) };
      case 'status': return { kind: 'status', value: await core.dispatch('get_status', {}) };
      default: throw new Error(`未知 CLI 命令：${cmd}`);
    }
  });

  if (asJson) {
    console.log(JSON.stringify(result.value, null, 2));
  } else if (result.kind === 'report') {
    const r = result.value;
    for (const item of r.results) {
      console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name.padEnd(28)} ${item.duration_ms} ms  ${item.detail}`);
    }
    console.log(`\n${r.passed ? 'SELFTEST PASSED' : 'SELFTEST FAILED'}  ${r.results.filter((x) => x.ok).length}/${r.results.length}  ${r.elapsed_ms} ms`);
  } else {
    out(result.kind + ':', result.value);
  }
  if (result.kind === 'report' && !result.value.passed) process.exitCode = 1;
}

main().catch((e) => {
  console.error('CLI_ERROR:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
