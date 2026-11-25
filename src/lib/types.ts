export type CaptureMode = 'manual' | 'auto';
export type CaptureScope = 'full' | 'rect';
export type ProviderKind = 'LocalLlama' | 'OpenAiCompatible';
export type ProviderState = 'stopped' | 'loading' | 'ready' | 'error';

export interface Note {
  id: number;
  title: string;
  summary: string;
  ocr_text: string;
  keywords: string[];
  source_app: string;
  window_title: string;
  section: string;
  created_at: number;
  updated_at: number;
  capture_mode: CaptureMode;
  latency_ms: number;
  provider: string;
  parse_ok: boolean;
  ocr_chars: number;
  section_id: number | null;
  kind: NoteKind;
  transcript_text: string;
  primary_asset_id: number | null;
  primary_asset_url?: string;
}

export interface Section {
  name: string;
  count: number;
  builtin: boolean;
}

export interface ApiConfig {
  base_url: string;
  api_key: string;
  model: string;
  timeout_ms: number;
}

export interface AsrConfig {
  base_url: string;
  api_key: string;
  model: string;
  language: string;
  timeout_ms: number;
}

export interface CaptionStyle {
  font_size: number;
  font_color: string;
  background: boolean;
  bg_color: string;
  opacity: number;
  visible: boolean;
}

export interface Settings {
  caption_engine?: 'auto' | 'cloud' | 'local';
  caption_processing?: {profile:'balanced'|'fast';concurrency:number};
  reading_mode?: 'auto' | 'article' | 'document' | 'chat' | 'code';
  audio_source?: 'loopback' | 'microphone';
  onboarding_done?: boolean;
  companion_pace?: 'quiet' | 'balanced' | 'active';
  hotkey: string;
  auto_enabled: boolean;
  auto_interval_secs: number;
  stable_ms: number;
  min_summary_interval_secs: number;
  merge_window_minutes: number;
  provider: ProviderKind;
  api_config: ApiConfig;
  asr_config?: AsrConfig;
  caption_style?: CaptionStyle;
  data_dir: string;
  max_ocr_chars: number;
  capture_scope: CaptureScope;
  always_on_top?: boolean;
}

export interface ProviderStatus {
  name: ProviderKind;
  state: ProviderState;
  detail: string;
  model_path: string;
  port: number | null;
  load_ms: number | null;
  last_infer_ms: number | null;
  ocr_language: string;
  api_supported: boolean;
}

export interface AppStatus {
  phase: 'idle' | 'capturing' | 'processing' | 'ocr' | 'summarizing' | 'saving' | 'done' | 'error';
  message: string;
  busy: boolean;
  auto_enabled: boolean;
  last_error: string | null;
  last_note_id: number | null;
  internal_foreground: boolean;
}

export interface ShellState {
  scope: CaptureScope;
  auto_enabled: boolean;
  phase: AppStatus['phase'];
  message: string;
  busy: boolean;
  notes_count: number;
  model_state: ProviderState;
  hotkey: string;
  always_on_top?: boolean;
  last_note?: { id: number; title: string; summary: string } | null;
}

export interface Stats {
  notes_count: number;
  captures: number;
  ocr_calls: number;
  summarize_calls: number;
  skipped_no_change: number;
  merged_notes: number;
  model_load_ms: number | null;
  last_infer_ms: number | null;
  last_ocr_ms: number | null;
  last_total_ms: number | null;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  duration_ms: number;
}

export interface SelftestReport {
  passed: boolean;
  results: CheckResult[];
  elapsed_ms: number;
}

export interface CaptureResult {
  pending?: boolean;
  scope?: CaptureScope;
  id?: number;
}

export type NoteKind = 'screenshot' | 'auto_promoted' | 'transcript' | 'mixed';
export type DraftStatus = 'pending' | 'committed' | 'discarded';
export type DraftKind = 'manual' | 'auto_promoted' | 'caption_window';

export interface SectionRow {
  id: number;
  parent_id: number | null;
  name: string;
  sort: number;
  builtin: boolean;
  count: number;
  path: string;
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
  asset_id?: number;
  asset_relative_path?: string;
}

export interface CaptionSessionRow {
  id: number;
  source: 'loopback' | 'mic' | 'both';
  provider: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  review_deadline: number | null;
}
