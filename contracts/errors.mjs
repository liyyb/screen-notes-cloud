/**
 * 屏幕笔记 · 稳定错误码契约（Node 端实现）。
 * Rust 端 src-tauri/src/error.rs 必须导出完全相同的 code 集合与语义。
 * 错误码一旦发布不可更改含义，只能新增。
 */
export const ERROR_CODES = Object.freeze({
  // 通用
  UNKNOWN: 'UNKNOWN',
  INVALID_ARGS: 'INVALID_ARGS',
  NOT_FOUND: 'NOT_FOUND',
  BUSY: 'BUSY',

  // 截屏 / OCR
  CAPTURE_FAILED: 'CAPTURE_FAILED',
  OCR_FAILED: 'OCR_FAILED',
  OCR_EMPTY: 'OCR_EMPTY',
  OCR_LANGUAGE_MISSING: 'OCR_LANGUAGE_MISSING',

  // 模型 / Provider
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  MODEL_LOAD_FAILED: 'MODEL_LOAD_FAILED',
  MODEL_TIMEOUT: 'MODEL_TIMEOUT',
  PROVIDER_DISABLED: 'PROVIDER_DISABLED',
  PROVIDER_UNAUTHORIZED: 'PROVIDER_UNAUTHORIZED',
  PROVIDER_NETWORK: 'PROVIDER_NETWORK',

  // 数据 / 迁移
  DB_READONLY: 'DB_READONLY',
  MIGRATION_FAILED: 'MIGRATION_FAILED',
  DRAFT_NOT_COMMITTED: 'DRAFT_NOT_COMMITTED',

  // 音频 / ASR
  ASR_NOT_READY: 'ASR_NOT_READY',
  AUDIO_CAPTURE_FAILED: 'AUDIO_CAPTURE_FAILED'
});

/** code -> 人类可读的稳定中文文案。新增错误码时在此补充。 */
export const ERROR_MESSAGES = Object.freeze({
  UNKNOWN: '发生未知错误',
  INVALID_ARGS: '参数不合法',
  NOT_FOUND: '目标不存在',
  BUSY: '上一条任务仍在处理中，请稍候',
  CAPTURE_FAILED: '截屏失败',
  OCR_FAILED: 'OCR 识别失败',
  OCR_EMPTY: 'OCR 未识别到有效文字',
  OCR_LANGUAGE_MISSING: '缺少中文 OCR 语言包',
  MODEL_NOT_FOUND: '本地模型文件缺失',
  MODEL_LOAD_FAILED: '本地模型加载失败',
  MODEL_TIMEOUT: '本地模型加载超时',
  PROVIDER_DISABLED: '该能力未启用',
  PROVIDER_UNAUTHORIZED: '未授权外发数据',
  PROVIDER_NETWORK: '云端服务不可达',
  DB_READONLY: '笔记数据库无法写入',
  MIGRATION_FAILED: '数据库迁移失败',
  DRAFT_NOT_COMMITTED: '草稿尚未归档为笔记',
  ASR_NOT_READY: '语音模型尚未就绪',
  AUDIO_CAPTURE_FAILED: '音频采集失败'
});

/** 判定错误是否允许用户重试。 */
export const RETRYABLE = new Set([
  'BUSY',
  'OCR_EMPTY',
  'MODEL_LOAD_FAILED',
  'MODEL_TIMEOUT',
  'PROVIDER_NETWORK',
  'DB_READONLY',
  'ASR_NOT_READY',
  'AUDIO_CAPTURE_FAILED'
]);

export function errorOf(code, detail = '') {
  const message = ERROR_MESSAGES[code] ?? ERROR_MESSAGES.UNKNOWN;
  return {
    code,
    message: detail ? `${message}：${detail}` : message,
    retryable: RETRYABLE.has(code)
  };
}

/** 统一错误类型：Node 与 Rust 通过 `instanceof ContractError` / code 字段对齐。 */
export class ContractError extends Error {
  constructor(code, detail = '') {
    const e = errorOf(code, detail);
    super(e.message);
    this.name = 'ContractError';
    this.code = e.code;
    this.retryable = e.retryable;
  }
}
