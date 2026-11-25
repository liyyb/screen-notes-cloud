/**
 * 契约一致性测试（Node 端）。
 * 验证：
 *  - contracts/ 下的错误码、Brief 结构、命令/事件清单内部自洽；
 *  - Brief 归一化与固定夹具正确；
 *  - 错误码与文案映射完整；
 *  - 迁移 SQL 文件存在且版本号递增。
 * 不启动服务、不访问真实 data/、不加载模型。
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const results = [];
function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: String(detail ?? ''), duration_ms: Date.now() - t0 });
  } catch (e) {
    results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e), duration_ms: Date.now() - t0 });
  }
}

async function main() {
  const { ERROR_CODES, ERROR_MESSAGES, errorOf, ContractError, RETRYABLE } = await import('../contracts/errors.mjs');
  const { BRIEF_DISPLAY_MAX, BRIEF_FIXTURE, normalizeBrief, TEXT_PROVIDERS, ASR_PROVIDERS } = await import('../contracts/brief.mjs');
  const { COMMANDS, EVENTS, NOTE_FIELDS, DRAFT_FIELDS, CAPTURE_MODES, NOTE_KINDS, DRAFT_KINDS, DRAFT_STATUS, SESSION_STATUS } = await import('../contracts/commands.mjs');
  const { listMigrations } = await import('../runtime/migrate.mjs');

  check('错误码与文案一一对应', () => {
    const codes = Object.values(ERROR_CODES);
    const msgKeys = Object.keys(ERROR_MESSAGES);
    const missing = codes.filter((c) => !msgKeys.includes(c));
    if (missing.length) throw new Error(`缺少文案：${missing.join(',')}`);
    return `${codes.length} 个错误码全部有文案`;
  });

  check('错误码集合无重复', () => {
    const codes = Object.values(ERROR_CODES);
    if (new Set(codes).size !== codes.length) throw new Error('错误码存在重复');
    return '无重复';
  });

  check('errorOf 返回稳定结构', () => {
    const e = errorOf('NOT_FOUND', 'x');
    if (e.code !== 'NOT_FOUND' || !e.message.includes('x') || typeof e.retryable !== 'boolean') {
      throw new Error('errorOf 结构异常');
    }
    return `NOT_FOUND -> ${e.message}`;
  });

  check('ContractError 携带 code 与 retryable', () => {
    const e = new ContractError('BUSY');
    if (e.code !== 'BUSY' || e.retryable !== true) throw new Error('ContractError 字段异常');
    if (!RETRYABLE.has('BUSY')) throw new Error('BUSY 应在可重试集合');
    return 'BUSY 可重试，code 正确';
  });

  check('Brief 夹具结构完整', () => {
    const f = BRIEF_FIXTURE;
    const req = ['display', 'key_points', 'todos', 'decisions', 'entities', 'detail', 'insight', 'source_refs', 'provider', 'parse_ok'];
    for (const k of req) if (!(k in f)) throw new Error(`缺少字段 ${k}`);
    if (f.display.length > BRIEF_DISPLAY_MAX) throw new Error('display 超长');
    if (!TEXT_PROVIDERS.includes(f.provider)) throw new Error(`provider 非法 ${f.provider}`);
    return `display=${f.display.length} 字，provider=${f.provider}`;
  });

  check('normalizeBrief 填充默认值并截断超长', () => {
    const b = normalizeBrief({ display: 'x'.repeat(200), provider: 'OpenAiCompatibleText', parse_ok: true });
    if (b.display.length !== BRIEF_DISPLAY_MAX) throw new Error(`display 未截断到 ${BRIEF_DISPLAY_MAX}`);
    if (!Array.isArray(b.key_points) || !Array.isArray(b.source_refs)) throw new Error('数组字段未归一化');
    return `display 截断为 ${b.display.length} 字，数组已归一化`;
  });

  check('normalizeBrief 容错空输入', () => {
    const b = normalizeBrief(null);
    if (b.display !== '' || b.parse_ok !== true) throw new Error('空输入容错失败');
    return '空输入返回安全默认值';
  });

  check('Provider 分类互斥且完整', () => {
    const text = new Set(TEXT_PROVIDERS);
    const asr = new Set(ASR_PROVIDERS);
    for (const p of text) if (asr.has(p)) throw new Error(`Provider ${p} 同时属于文本与 ASR`);
    return `文本 ${text.size} 个，ASR ${asr.size} 个`;
  });

  check('命令清单无重复且含核心命令', () => {
    if (new Set(COMMANDS).size !== COMMANDS.length) throw new Error('命令存在重复');
    for (const c of ['get_notes', 'capture_manual', 'list_drafts', 'commit_draft', 'start_caption']) {
      if (!COMMANDS.includes(c)) throw new Error(`缺少命令 ${c}`);
    }
    return `${COMMANDS.length} 个命令，核心命令齐全`;
  });

  check('事件清单无重复', () => {
    if (new Set(EVENTS).size !== EVENTS.length) throw new Error('事件存在重复');
    return `${EVENTS.length} 个事件`;
  });

  check('DTO 字段清单无重复且必要字段在列', () => {
    if (new Set(NOTE_FIELDS).size !== NOTE_FIELDS.length) throw new Error('NOTE_FIELDS 重复');
    for (const k of ['id', 'kind', 'section_id', 'brief_json', 'ocr_raw', 'transcript_text']) {
      if (!NOTE_FIELDS.includes(k)) throw new Error(`NOTE_FIELDS 缺少 ${k}`);
    }
    for (const k of ['id', 'kind', 'status', 'committed_note_id']) {
      if (!DRAFT_FIELDS.includes(k)) throw new Error(`DRAFT_FIELDS 缺少 ${k}`);
    }
    return `NOTE_FIELDS ${NOTE_FIELDS.length} 项，DRAFT_FIELDS ${DRAFT_FIELDS.length} 项`;
  });

  check('枚举与状态集合完整', () => {
    if (CAPTURE_MODES.length !== 4 || NOTE_KINDS.length !== 4) throw new Error('capture/kind 枚举缺失');
    if (DRAFT_KINDS.length !== 3 || DRAFT_STATUS.length !== 3) throw new Error('草稿枚举缺失');
    if (SESSION_STATUS.length !== 5) throw new Error('会话状态缺失');
    return `capture=${CAPTURE_MODES.length} kind=${NOTE_KINDS.length} draft=${DRAFT_KINDS.length}/${DRAFT_STATUS.length} session=${SESSION_STATUS.length}`;
  });

  check('迁移文件存在且版本递增', () => {
    const ms = listMigrations(path.join(root, 'migrations'));
    if (ms.length < 2) throw new Error(`迁移文件不足：${ms.length}`);
    for (let i = 1; i < ms.length; i++) {
      if (ms[i].version !== ms[i - 1].version + 1) throw new Error(`版本不连续：${ms[i - 1].name} -> ${ms[i].name}`);
    }
    return ms.map((m) => m.name).join(', ');
  });

  check('迁移 SQL 含 user_version 推进', () => {
    const ms = listMigrations(path.join(root, 'migrations'));
    for (const m of ms) {
      const sql = fs.readFileSync(m.file, 'utf8');
      if (!sql.includes('user_version')) throw new Error(`${m.name} 未推进 user_version`);
    }
    return '全部迁移均推进 user_version';
  });

  const failed = results.filter((r) => !r.ok);
  console.log('\n===== 契约测试 =====');
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(28)} ${String(r.duration_ms).padStart(5)} ms  ${r.detail}`);
  console.log(`${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('CONTRACT_TEST_ERROR:', e);
  process.exit(1);
});
