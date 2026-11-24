/**
 * Brief 契约常量与夹具（Node 端）。
 * Rust 端与前端 TS 必须消费同一份结构；夹具用于跨后端一致性测试。
 */
export const BRIEF_DISPLAY_MAX = 120;

export const PROVIDER_KINDS = Object.freeze({
  LocalLlama: 'LocalLlama',
  OpenAiCompatibleText: 'OpenAiCompatibleText',
  LocalWhisper: 'LocalWhisper',
  WindowsSpeech: 'WindowsSpeech',
  OpenAiCompatibleASR: 'OpenAiCompatibleASR'
});

export const TEXT_PROVIDERS = [PROVIDER_KINDS.LocalLlama, PROVIDER_KINDS.OpenAiCompatibleText];
export const ASR_PROVIDERS = [PROVIDER_KINDS.LocalWhisper, PROVIDER_KINDS.WindowsSpeech, PROVIDER_KINDS.OpenAiCompatibleASR];

/** 固定夹具：跨 Node/Rust 一致性测试用，字段顺序与值均不允许漂移。 */
export const BRIEF_FIXTURE = Object.freeze({
  display: '团队讨论下周二发布计划，张三负责接口联调，李四准备测试用例。',
  key_points: ['下周二发布', '张三负责接口联调', '李四准备测试用例'],
  todos: ['完成接口联调', '准备测试用例'],
  decisions: ['确定下周二发布'],
  entities: ['张三', '李四'],
  detail: '',
  insight: '',
  source_refs: ['ocr:12', 'ocr:18'],
  provider: 'LocalLlama',
  parse_ok: true
});

/** 构造一个规范的 Brief 对象，填充默认值并保证 display 不超长。 */
export function normalizeBrief(raw) {
  const r = raw ?? {};
  const str = (v) => (Array.isArray(v) ? v.map(String) : []);
  let display = String(r.display ?? '').trim();
  if (display.length > BRIEF_DISPLAY_MAX) {
    display = display.slice(0, BRIEF_DISPLAY_MAX);
  }
  return {
    display,
    key_points: str(r.key_points),
    todos: str(r.todos),
    decisions: str(r.decisions),
    entities: str(r.entities),
    detail: String(r.detail ?? '').trim(),
    insight: String(r.insight ?? '').trim(),
    source_refs: str(r.source_refs),
    provider: String(r.provider ?? 'LocalLlama'),
    parse_ok: r.parse_ok !== false
  };
}
