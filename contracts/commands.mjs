/**
 * 命令、事件与 DTO 字段契约（Node 端）。
 * Rust 端 src-tauri/src/contract.rs 必须导出同名命令与事件；前端 TS 亦引用此清单。
 * 命令名 / 事件名 / 字段名一旦发布不可随意改名，只能新增或加版本后缀。
 */

/** 统一命令名清单。 */
export const COMMANDS = Object.freeze([
  // 查询 / 管理
  'get_notes', 'get_note', 'update_note', 'delete_note', 'clear_notes',
  'export_note', 'list_sections', 'set_note_section', 'create_section',
  'rename_section', 'delete_section', 'reorder_sections',
  // 草稿
  'list_drafts', 'get_draft', 'commit_draft', 'discard_draft',
  // 手动截屏
  'capture_manual', 'capture_grab', 'capture_process', 'capture_execute',
  'capture_with_image', 'capture_with_text',
  // auto
  'set_auto_mode',
  // 字幕 / 音频
  'request_caption_review', 'get_companion_state', 'collect_inspire', 'get_caption_session', 'start_caption', 'stop_caption', 'caption_save_scope', 'list_caption_sessions',
  // 设置 / 状态
  'get_status', 'get_stats', 'get_settings', 'update_settings',
  'set_capture_scope', 'set_always_on_top', 'get_shell_state', 'shell_poll',
  'get_provider_status', 'start_model', 'get_config', 'open_data_dir', 'selftest'
]);

/** 状态机事件名（供 shell / 前端订阅）。 */
export const EVENTS = Object.freeze([
  'auto_note', 'auto_processing', 'caption_partial', 'caption_final',
  'caption_started', 'caption_stopped', 'provider_changed', 'error'
]);

/** 笔记 DTO 的稳定字段（跨后端序列化对齐用，值以实际返回为准）。 */
export const NOTE_FIELDS = Object.freeze([
  'id', 'kind', 'section_id', 'primary_asset_id', 'brief_json', 'detail_json',
  'ocr_raw', 'ocr_clean', 'ocr_lines_json', 'transcript_text',
  'source_app', 'window_title', 'capture_mode', 'provider', 'parse_ok',
  'latency_ms', 'created_at', 'updated_at'
]);

/** 草稿 DTO 稳定字段。 */
export const DRAFT_FIELDS = Object.freeze([
  'id', 'kind', 'status', 'brief_json', 'detail_json', 'ocr_raw', 'ocr_clean',
  'ocr_lines_json', 'transcript_text', 'source_app', 'window_title',
  'created_at', 'updated_at', 'committed_note_id'
]);

/** 记录来源方式。 */
export const CAPTURE_MODES = Object.freeze(['manual', 'auto_promoted', 'transcript', 'mixed']);

/** 笔记 kind。 */
export const NOTE_KINDS = Object.freeze(['screenshot', 'auto_promoted', 'transcript', 'mixed']);

/** 草稿 kind。 */
export const DRAFT_KINDS = Object.freeze(['manual', 'auto_promoted', 'caption_window']);

/** 草稿状态。 */
export const DRAFT_STATUS = Object.freeze(['pending', 'committed', 'discarded']);

/** 字幕会话状态。 */
export const SESSION_STATUS = Object.freeze(['recording', 'review', 'saved_full', 'saved_selected', 'discarded']);
