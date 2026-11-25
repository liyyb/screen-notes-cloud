import { call } from './transport';
import type {
  AppStatus,
  CaptureResult,
  CaptureScope,
  CaptionSessionRow,
  CaptionStyle,
  Draft,
  DraftStatus,
  Note,
  ProviderStatus,
  Section,
  SectionRow,
  SelftestReport,
  Settings,
  ShellState,
  Stats
} from './types';

export const api = {
  getNotes: (query = '', section = '', limit = 200) =>
    call<Note[]>('get_notes', { query, section, limit }),
  getNote: (id: number) => call<Note>('get_note', { id }),
  getNoteAssets: (id: number) => call<Array<{ id: number; relative_path: string; url: string; mime: string; width: number; height: number }>>('get_note_assets', { id }),
  updateNote: (id: number, title: string, summary: string) =>
    call<Note>('update_note', { id, title, summary }),
  deleteNote: (id: number) => call<boolean>('delete_note', { id }),
  exportNote: (id: number) => call<string>('export_note', { id }),
  captureManual: () => call<CaptureResult>('capture_manual', {}),
  captureWithImage: (imagePath: string) => call<Note>('capture_with_image', { imagePath }),
  setAutoMode: (enabled: boolean) => call<AppStatus>('set_auto_mode', { enabled }),
  setCaptureScope: (scope: CaptureScope) => call<Settings>('set_capture_scope', { scope }),
  getShellState: () => call<ShellState>('get_shell_state', {}),
  listSections: () => call<Section[]>('list_sections', {}),
  setNoteSection: (id: number, section: string) =>
    call<Note>('set_note_section', { id, section }),
  getStatus: () => call<AppStatus>('get_status', {}),
  getStats: () => call<Stats>('get_stats', {}),
  getSettings: () => call<Settings>('get_settings', {}),
  updateSettings: (settings: Settings) => call<Settings>('update_settings', { settings }),
  getProviderStatus: () => call<ProviderStatus>('get_provider_status', {}),
  startModel: () => call<ProviderStatus>('start_model', {}),
  openDataDir: () => call<string>('open_data_dir', {}),
  selftest: () => call<SelftestReport>('selftest', {}),
  clearNotes: () => call<boolean>('clear_notes', {}),
  // 分区实体
  listSectionRows: () => call<SectionRow[]>('list_section_rows', {}),
  createSection: (name: string, path?: string) => call<SectionRow>('create_section', { name, path: path ?? '' }),
  renameSection: (id: number, name: string) => call<SectionRow>('rename_section', { id, name }),
  deleteSection: (id: number) => call<boolean>('delete_section', { id }),
  setSectionPath: (id: number, path: string) => call<SectionRow>('set_section_path', { id, path }),
  pickFolder: (initial?: string) => call<string>('pick_folder', { initial: initial ?? '' }),
  // 草稿
  listDrafts: (status?: DraftStatus) => call<Draft[]>('list_drafts', { status }),
  getDraft: (id: number) => call<Draft>('get_draft', { id }),
  discardDraft: (id: number) => call<boolean>('discard_draft', { id }),
  commitDraft: (id: number, section_id: number | null) => call<Note>('commit_draft', { id, section_id }),
  captureToDraft: (args?: Record<string, unknown>) => call<Draft>('capture_to_draft', args ?? {}),
  // auto 灵感
  getCompanionState: () => call<any>('get_companion_state', {}),
  collectInspire: (id: string) => call<Note>('collect_inspire', { id }),
  autoInspire: (args?: Record<string, unknown>) => call<Record<string, unknown>>('auto_inspire', args ?? {}),
  autoPromote: () => call<Draft>('auto_promote', {}),
  // 字幕
  startCaption: (provider: string, source: string) => call<Record<string, unknown>>('start_caption', { provider, source }),
  captionFeed: (args: Record<string, unknown>) => call<Record<string, unknown>>('caption_feed', args),
  captionSaveScope: (strategy: string, section_id: number | null) => call<Record<string, unknown>>('caption_save_scope', { strategy, section_id }),
  getCaptionSession: (session_id: number) => call<any>('get_caption_session', { session_id }),
  markCaption: (session_id: number, transcript_id: number, selected: boolean) => call('caption_mark', { session_id, transcript_id, selected }),
  saveCaptionSession: (session_id: number, strategy: string, section_id: number | null, allow_incomplete = false) => call<any>('caption_save_scope', { session_id, strategy, section_id, polish: true, allow_incomplete }),
  stopCaption: () => call<Record<string, unknown>>('stop_caption', {}),
  listCaptionSessions: () => call<CaptionSessionRow[]>('list_caption_sessions', {}),
  captionStatus: () => call<{ active: boolean; waiting_audio_ms?: number; failed_segments?: number; queued_segments?: number; audio_running?: boolean; error?: string | null; pending_review_id?: number | null; session_id: number | null; provider: string | null; lines: Array<{ id: number; text: string }>; style: CaptionStyle }>('caption_status', {}),
  setCaptionStyle: (style: Partial<CaptionStyle>) => call<CaptionStyle>('set_caption_style', { style })
};

export const SCOPE_LABELS: Record<CaptureScope, string> = {
  full: '全屏',
  rect: '矩形选区'
};

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function downloadMarkdown(title: string, markdown: string): void {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safe = (title || 'note').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  a.href = url;
  a.download = `${safe}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
