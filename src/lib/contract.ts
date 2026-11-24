/**
 * 前端契约类型：与 contracts/ 下共享契约、runtime 后端一一对应。
 * 字段名必须与 NOTE_FIELDS / DRAFT_FIELDS 等契约清单保持一致。
 */

export const BRIEF_DISPLAY_MAX = 120;

export type ProviderKind =
  | 'LocalLlama'
  | 'OpenAiCompatibleText'
  | 'LocalWhisper'
  | 'WindowsSpeech'
  | 'OpenAiCompatibleASR';

export type NoteKind = 'screenshot' | 'auto_promoted' | 'transcript' | 'mixed';
export type DraftKind = 'manual' | 'auto_promoted' | 'caption_window';
export type DraftStatus = 'pending' | 'committed' | 'discarded';
export type SessionStatus = 'recording' | 'review' | 'saved_full' | 'saved_selected' | 'discarded';

/** Brief：本地/云端文本 Provider 的统一输出结构。 */
export interface Brief {
  display: string;
  key_points: string[];
  todos: string[];
  decisions: string[];
  entities: string[];
  detail: string;
  insight: string;
  source_refs: string[];
  provider: ProviderKind;
  parse_ok: boolean;
}

export interface OcrLine {
  id: number;
  text: string;
}

export interface Draft {
  id: number;
  kind: DraftKind;
  status: DraftStatus;
  brief_json: string;
  detail_json: string;
  ocr_raw: string;
  ocr_clean: string;
  ocr_lines_json: string;
  transcript_text: string;
  source_app: string;
  window_title: string;
  created_at: number;
  updated_at: number;
  committed_note_id: number | null;
}

export interface Section {
  id: number;
  parent_id: number | null;
  name: string;
  sort: number;
  builtin: boolean;
  count: number;
}

export interface CaptionSession {
  id: number;
  source: 'loopback' | 'mic' | 'both';
  provider: ProviderKind;
  status: SessionStatus;
  started_at: number;
  ended_at: number | null;
  review_deadline: number | null;
}

export interface TranscriptLine {
  id: number;
  session_id: number;
  note_id: number | null;
  start_ms: number;
  end_ms: number;
  text: string;
  is_final: boolean;
  selected: boolean;
}

export interface ContractError {
  code: string;
  message: string;
  retryable: boolean;
}

export function parseBrief(json: string): Brief {
  try {
    const o = JSON.parse(json);
    return {
      display: String(o.display ?? '').slice(0, BRIEF_DISPLAY_MAX),
      key_points: Array.isArray(o.key_points) ? o.key_points.map(String) : [],
      todos: Array.isArray(o.todos) ? o.todos.map(String) : [],
      decisions: Array.isArray(o.decisions) ? o.decisions.map(String) : [],
      entities: Array.isArray(o.entities) ? o.entities.map(String) : [],
      detail: String(o.detail ?? ''),
      insight: String(o.insight ?? ''),
      source_refs: Array.isArray(o.source_refs) ? o.source_refs.map(String) : [],
      provider: (o.provider ?? 'LocalLlama') as ProviderKind,
      parse_ok: o.parse_ok !== false
    };
  } catch {
    return {
      display: '', key_points: [], todos: [], decisions: [], entities: [],
      detail: '', insight: '', source_refs: [],
      provider: 'LocalLlama', parse_ok: false
    };
  }
}
