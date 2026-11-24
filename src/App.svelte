<script lang="ts">
  import { call } from './lib/transport';
  import { onMount, onDestroy } from 'svelte';
  import { api, formatTime, downloadMarkdown, SCOPE_LABELS } from './lib/api';
  import { backendName } from './lib/transport';
  import type { AppStatus, CaptureScope, Note, ProviderStatus, Section, SelftestReport, Settings, ShellState, Stats, SectionRow, Draft } from './lib/types';

  let notes: Note[] = [];
  let sections: Section[] = [];
  let sectionRows: SectionRow[] = [];
  let drafts: Draft[] = [];
  let query = '';
  let activeSection = '全部';
  let selectedId: number | null = null;
  let detail: Note | null = null;
  let detailAssets: Array<{ id: number; relative_path: string; url: string; mime: string; width: number; height: number }> = [];
  let tab: 'summary' | 'ocr' | 'transcript' = 'summary';
  let titleDraft = '';
  let summaryDraft = '';
  let dirty = false;
  let newSectionName = '';
  let showScopeMenu = false;
  let scope: CaptureScope = 'full';
  // 草稿选择分区
  let pendingDraftId: number | null = null;
  let showDraftPicker = false;
  let showReview = false; // 回看文字抽屉

  let status: AppStatus = { phase: 'idle', message: '就绪 · 手动模式', busy: false, auto_enabled: false, last_error: null, last_note_id: null, internal_foreground: false };
  let stats: Stats = { notes_count: 0, captures: 0, ocr_calls: 0, summarize_calls: 0, skipped_no_change: 0, merged_notes: 0, model_load_ms: null, last_infer_ms: null, last_ocr_ms: null, last_total_ms: null };
  let provider: ProviderStatus = { name: 'LocalLlama', state: 'stopped', detail: '未启动', model_path: '', port: null, load_ms: null, last_infer_ms: null, ocr_language: '-', api_supported: false };
  let shell: ShellState | null = null;
  let settings: Settings | null = null;
  let settingsDraft: Settings | null = null;

  let showReadiness = false;
  let readiness: any = null;
  let readinessBusy = false;
  let captionQueue = 0;
  let captionError = '';
  let waitingAudioMs = 0;
  let failedSegments = 0;
  let localAsr: any = null;
  let incompleteCaption = false;
  async function installLocalAsr() { try { localAsr = await call('install_local_asr',{repair:!!localAsr?.ready}); notify('开始下载本地识别组件，可稍后查看进度'); } catch(e) { fail(e); } }
  async function checkReady(network = false, audio = false) {
    if (readinessBusy) return;
    readinessBusy = true;
    try { readiness = await call('check_readiness', {network,audio}); } catch(e) { fail(e); }
    finally { readinessBusy = false; }
  }
  async function readingAction(command: string) {
    try { await call(command); notify(command === 'request_reading_region' ? '请回到阅读页面，拖动框选关注区域；Esc 可取消' : command === 'show_reading_region' ? '当前识别区域将短暂高亮' : '已恢复自动选择正文'); }
    catch(e) { fail(e); }
  }
  function presetCaption(name: string) {
    if (!settingsDraft) return;
    const presets: Record<string, any> = {default:{font_size:28,font_color:'#FFFFFF',background:true,bg_color:'#3C3C3C',opacity:75,visible:true},contrast:{font_size:32,font_color:'#FFFFFF',background:true,bg_color:'#111111',opacity:95,visible:true},large:{font_size:42,font_color:'#FFE08A',background:true,bg_color:'#202020',opacity:85,visible:true}};
    settingsDraft.caption_style = {...presets[name]};
  }
  let showSettings = false;
  let showReport = false;
  let report: SelftestReport | null = null;
  let toast = '';
  let toastErr = false;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let lastNoteId: number | null = null;
  let busy = false;

  // 字幕模式状态
  let companion: any = null;
  let companionBusy = false;
  async function chatAboutPage() {
    if (companionBusy) return;
    companionBusy = true;
    try { const r = await api.autoInspire(); if (r.skipped) notify(r.reason); else companion = r; } catch(e) { fail(e); } finally { companionBusy = false; }
  }
  async function collectCompanion() {
    if (!companion?.id) return;
    try { const n = await api.collectInspire(companion.id); companion = { ...companion, note_id: n.id }; await refreshNotes(false); await refreshSections(); notify('已收藏到收集箱'); } catch(e) { fail(e); }
  }
  let captionActive = false;
  let captionProviderName = '';
  let captionStarting = false;
  type CaptionTiming = {
    session_id: number;
    provider: string;
    source: string;
    heard_sound: boolean;
    startup_ms: number | null;
    first_submit_ms: number | null;
    first_text_ms: number | null;
    first_final_ms: number | null;
    first_paint_ms: number | null;
    paint_delay_ms: number | null;
    stop_ms: number | null;
  };
  let captionTiming: CaptionTiming | null = null;
  let testingCaption = false;
  let savedCaptionNoteId: number | null = null;
  const timingText = (ms: number | null) => ms === null ? '等待数据' : `${ms} 毫秒`;
  let lastReviewRequest: number | null = null;
  let showRecovery = false;
  let captionSessions: any[] = [];
  let reviewSession: any = null;
  let recoveryBusy = false;
  let captionSection: number | null = null;

  async function openRecovery() {
    await refreshSections();
    captionSessions = (await api.listCaptionSessions()).filter(s => ['review', 'recording'].includes(s.status));
    showRecovery = true;
  }
  async function reviewCaption(id: number) {
    try { reviewSession = await api.getCaptionSession(id); incompleteCaption = false; } catch(e) { fail(e); }
  }
  async function markTranscript(id: number, selected: boolean) {
    if (recoveryBusy) return;
    recoveryBusy = true;
    try { await api.markCaption(reviewSession.id, id, selected); await reviewCaption(reviewSession.id); } catch(e) { fail(e); } finally { recoveryBusy = false; }
  }
  async function saveCaption(strategy: string) {
    if (recoveryBusy || !reviewSession) return;
    if (strategy === 'discard' && !confirm('确定丢弃这场字幕？')) return;
    recoveryBusy = true;
    try {
      const saved = await api.saveCaptionSession(reviewSession.id, strategy, captionSection, incompleteCaption);
      savedCaptionNoteId = saved.note_id ?? null;
      reviewSession = null; await openRecovery(); await refreshNotes(false);
      notify(strategy === 'discard' ? '已丢弃字幕' : `已保存到「${sectionRows.find(s=>s.id===captionSection)?.name ?? '收集箱'}」；数据位置：${settings?.data_dir ?? '软件 data 目录'}`);
    } catch(e) { fail(e); } finally { recoveryBusy = false; }
  }

  const scopes: CaptureScope[] = ['full', 'rect'];

  $: phaseDot = status.phase === 'error' ? 'err' : status.busy ? 'busy' : 'ok';
  $: providerDot = provider.state === 'ready' ? 'ok' : provider.state === 'error' ? 'err' : provider.state === 'loading' ? 'busy' : '';
  $: pendingDraftsCount = drafts.filter((d) => d.status === 'pending').length;
  $: allSections = (() => {
    const rows = sectionRows.filter((s) => !s.builtin || s.name === '收集箱');
    return [{ name: '全部', count: stats.notes_count, builtin: true }, ...rows.map((s) => ({ name: s.name, count: s.count, builtin: s.builtin, id: s.id }))];
  })();

  function notify(msg: string, isErr = false) {
    toast = msg;
    toastErr = isErr;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ''), 3200);
  }

  function fail(e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    notify(msg, true);
    status = { ...status, phase: 'error', busy: false, last_error: msg };
  }

  async function refreshSections() {
    try {
      sections = await api.listSections();
      sectionRows = await api.listSectionRows();
      drafts = await api.listDrafts();
    } catch { /* backend starting */ }
  }

  async function refreshNotes(keepSelection = true) {
    try {
      notes = await api.getNotes(query, activeSection === '全部' ? '' : activeSection, 200);
      if (!keepSelection || !notes.some((n) => n.id === selectedId)) {
        selectedId = notes.length ? notes[0].id : null;
        await loadDetail();
      }
    } catch (e) { fail(e); }
  }

  async function loadDetail() {
    if (selectedId == null) { detail = null; titleDraft = ''; summaryDraft = ''; detailAssets = []; return; }
    try {
      detail = await api.getNote(selectedId);
      titleDraft = detail.title;
      summaryDraft = detail.summary;
      detailAssets = await api.getNoteAssets(selectedId);
      dirty = false;
    } catch (e) { fail(e); }
  }

  async function selectNote(id: number) {
    if (dirty) await saveNote(true);
    selectedId = id;
    await loadDetail();
    tab = detail?.kind === 'transcript' ? 'transcript' : 'summary';
  }

  async function selectSection(name: string) {
    activeSection = name;
    selectedId = null;
    await refreshNotes(false);
  }

  // 手动记录：截屏 → 草稿 → 提示选分区 → 提交为正式笔记。
  async function capture() {
    if (busy) return;
    busy = true;
    try {
      const d = await api.captureToDraft({ with_image: true });
      pendingDraftId = d.id;
      showDraftPicker = true;
      notify(`已生成待归档草稿，请选择分区`);
      await refreshSections();
    } catch (e) { fail(e); }
    finally { busy = false; }
  }

  // 确认分区后提交草稿。
  async function commitDraftTo(sectionId: number | null) {
    if (pendingDraftId == null) return;
    const id = pendingDraftId;
    if (recoveryBusy) return;
    recoveryBusy = true;
    try {
      const note = await api.commitDraft(id, sectionId);
      showDraftPicker = false;
      pendingDraftId = null;
      selectedId = note.id;
      activeSection = sectionId != null ? (sectionRows.find((s) => s.id === sectionId)?.name ?? '全部') : '全部';
      await refreshNotes(false);
      await refreshSections();
      detail = note;
      detailAssets = await api.getNoteAssets(note.id);
      notify(`已保存笔记 #${note.id}`);
    } catch (e) { fail(e); } finally { recoveryBusy = false; }
  }

  async function discardPendingDraft() {
    if (pendingDraftId == null) return;
    await api.discardDraft(pendingDraftId);
    pendingDraftId = null;
    showDraftPicker = false;
    await refreshSections();
    notify('已丢弃草稿');
  }

  async function setScope(next: CaptureScope) {
    showScopeMenu = false;
    try {
      await api.setCaptureScope(next);
      scope = next;
      if (settings) settings = { ...settings, capture_scope: next };
      notify(`截屏范围：${SCOPE_LABELS[next]}`);
    } catch (e) { fail(e); }
  }

  async function toggleAuto() {
    try {
      status = await api.setAutoMode(!status.auto_enabled);
      notify(status.auto_enabled ? '陪伴已开启，正在看看当前页面' : '陪伴已暂停');
      if (settings) settings = { ...settings, auto_enabled: status.auto_enabled };
    } catch (e) { fail(e); }
  }

  async function saveNote(silent = false) {
    if (!detail) return;
    try {
      const updated = await api.updateNote(detail.id, titleDraft.trim(), summaryDraft.trim());
      detail = updated;
      dirty = false;
      await refreshNotes(true);
      if (!silent) notify('已保存修改');
    } catch (e) { fail(e); }
  }

  async function changeSection(name: string) {
    if (!detail || !name) return;
    try {
      detail = await api.setNoteSection(detail.id, name);
      await refreshSections();
      await refreshNotes(true);
      notify(`已移动到「${name}」`);
    } catch (e) { fail(e); }
  }

  async function createSection() {
    const name = newSectionName.trim();
    if (!name) return;
    try {
      // 弹文件夹选择器，让用户为分区指定磁盘存储位置（可取消）。
      let folderPath = '';
      try { folderPath = await api.pickFolder(); } catch { folderPath = ''; }
      const s = await api.createSection(name, folderPath);
      newSectionName = '';
      await refreshSections();
      notify(folderPath ? `已创建分区「${s.name}」，保存位置：${folderPath}` : `已创建分区「${s.name}」`);
    } catch (e) { fail(e); }
  }

  async function renameSection(id: number) {
    const s = sectionRows.find((x) => x.id === id);
    if (!s) return;
    const name = prompt('重命名分区：', s.name);
    if (!name) return;
    try {
      await api.renameSection(id, name.trim());
      await refreshSections();
      notify('已重命名');
    } catch (e) { fail(e); }
  }

  async function deleteSection(id: number) {
    const s = sectionRows.find((x) => x.id === id);
    if (!s) return;
    if (!confirm(`删除分区「${s.name}」？其中笔记会移动到「收集箱」。`)) return;
    try {
      await api.deleteSection(id);
      if (activeSection === s.name) activeSection = '全部';
      await refreshSections();
      await refreshNotes(false);
      notify('已删除分区');
    } catch (e) { fail(e); }
  }

  async function removeNote() {
    if (!detail) return;
    if (!confirm(`确定删除笔记 #${detail.id}？`)) return;
    try {
      await api.deleteNote(detail.id);
      selectedId = null;
      await refreshNotes(false);
      await refreshSections();
      notify('已删除');
    } catch (e) { fail(e); }
  }

  async function exportNote() {
    if (!detail) return;
    try {
      const md = await api.exportNote(detail.id);
      downloadMarkdown(detail.title || `笔记-${detail.id}`, md);
      notify('已导出 Markdown');
    } catch (e) { fail(e); }
  }

  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text); notify('已复制'); }
    catch { notify('复制失败，请手动选中', true); }
  }

  async function refreshStatus() {
    try {
      const [s, st, p, sh] = await Promise.all([
        api.getStatus(), api.getStats(), api.getProviderStatus(), api.getShellState()
      ]);
      status = s; stats = st; provider = p; shell = sh;
      companion = (await api.getCompanionState()).current;
      const cs = await api.captionStatus();
      if(showSettings) localAsr = await call('local_asr_status');
      captionProviderName = cs.provider ?? ''; captionActive = cs.active; captionQueue = cs.queued_segments ?? 0;waitingAudioMs=cs.waiting_audio_ms??0;failedSegments=cs.failed_segments??0; captionError = cs.active ? (cs.error ?? '') : '';
      if (showSettings && testingCaption) captionTiming = await call<CaptionTiming | null>('caption_timing').catch(() => null);
      if (cs.pending_review_id && cs.pending_review_id !== lastReviewRequest) {
        lastReviewRequest = cs.pending_review_id;
        await openRecovery(); await reviewCaption(cs.pending_review_id);
      }
      if (sh?.scope && sh.scope !== scope) scope = sh.scope;
      if (s.last_note_id != null && s.last_note_id !== lastNoteId) {
        lastNoteId = s.last_note_id;
        await refreshNotes(true);
        await refreshSections();
      }
    } catch { /* backend starting up */ }
  }

  function onSearch() {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => refreshNotes(false), 260);
  }

  async function openSettings() {
    try {
      settings = await api.getSettings();
      settingsDraft = JSON.parse(JSON.stringify(settings)) as Settings;
      settingsDraft.caption_engine ??= 'auto';
      settingsDraft.caption_processing ??= {profile:'balanced',concurrency:2};
      if (!settingsDraft.asr_config) {
        settingsDraft.asr_config = { base_url: 'https://api.siliconflow.cn/v1', api_key: '', model: 'FunAudioLLM/SenseVoiceSmall', language: 'zh', timeout_ms: 30000 };
      }
      if (!settingsDraft.caption_style) {
        settingsDraft.caption_style = { font_size: 28, font_color: '#FFFFFF', background: true, bg_color: '#3C3C3C', opacity: 75, visible: true };
      }
      localAsr = await call('local_asr_status');
      showSettings = true;
    } catch (e) { fail(e); }
  }

  async function saveSettings() {
    if (!settingsDraft) return;
    try {
      settings = await api.updateSettings(settingsDraft);
      scope = settings.capture_scope;
      showSettings = false;
      await refreshStatus();
      notify('设置已保存');
    } catch (e) { fail(e); }
  }

  async function startModel() {
    notify('正在检查 / 启动模型…');
    try { provider = await api.startModel(); await refreshStatus(); }
    catch (e) { fail(e); }
  }

  // 字幕模式：开始/停止语音转文字（系统声音回环 + 外部 ASR + 屏幕字幕条）。
  async function toggleCaption() {
    if (captionStarting) return;
    captionStarting = true;
    try {
      if (captionActive) {
        notify('正在收尾，等待最后一段字幕…');
        const result = await api.stopCaption();
        captionActive = false;
        captionTiming = await call<CaptionTiming | null>('caption_timing').catch(() => null);
        await openRecovery();
        await reviewCaption(Number(result.session_id));
        notify('字幕已停止，请选择保存方式');
      } else {
        captionStarting = true;
        const r = await api.startCaption('OpenAiCompatibleASR', (await api.getSettings()).audio_source ?? 'loopback');
        captionActive = true;
        const asrReady = r.asr_ready === true;
        const audioOk = r.audio_ok === true;
        notify(asrReady ? '字幕已开始（转写就绪）' : audioOk ? '字幕已开始（音频采集中）' : '字幕已开始');
      }
    } catch (e) { fail(e); }
    finally { captionStarting = false; }
  }

  async function testCaptionSpeed() {
    if (captionStarting || (captionActive && !testingCaption)) return;
    if (testingCaption && captionActive) showSettings = false;
    else captionTiming = null;
    await toggleCaption();
    testingCaption = captionActive;
    captionTiming = await call<CaptionTiming | null>('caption_timing').catch(() => null);
  }

  async function runSelftest() {
    notify('正在运行自检…');
    try {
      report = await api.selftest();
      showReport = true;
      notify(report.passed ? '自检全部通过' : '自检存在失败项', !report.passed);
      await refreshStatus();
      await refreshNotes(false);
      await refreshSections();
    } catch (e) { fail(e); }
  }

  async function openDataDir() {
    try { const p = await api.openDataDir(); notify(`数据目录：${p}`); }
    catch (e) { fail(e); }
  }

  async function clearAll() {
    if (!confirm('确定清空所有笔记？')) return;
    try {
      await api.clearNotes();
      selectedId = null;
      activeSection = '全部';
      await refreshNotes(false);
      await refreshSections();
      await refreshStatus();
      notify('已清空');
    } catch (e) { fail(e); }
  }

  onMount(() => {
    refreshNotes(false);
    refreshSections();
    refreshStatus();
    api.getSettings().then(s => { settings = s; if (!s.onboarding_done) showReadiness = true; }).catch(fail);
    pollTimer = setInterval(refreshStatus, 1200);
  });
  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    if (toastTimer) clearTimeout(toastTimer);
    if (searchTimer) clearTimeout(searchTimer);
  });
</script>

<div class="app">
  <header class="topbar">
    <div class="brand">
      <span class="mark">屏</span>
      <span class="name">屏幕笔记</span>
      <span class="ver">陪伴</span>
    </div>
    <div class="search">
      <input placeholder="搜索标题 / 摘要 / OCR 原文" bind:value={query} on:input={onSearch} />
    </div>
    <div class="spacer"></div>
    <div class="scope-wrap">
      <button class="scope-trigger" on:click={() => (showScopeMenu = !showScopeMenu)}>
        <span class="scope-glyph">▣</span>{SCOPE_LABELS[scope]}<span class="caret">⌄</span>
      </button>
      {#if showScopeMenu}
        <div class="scope-menu">
          {#each scopes as s}
            <button class:active={scope === s} on:click={() => setScope(s)}>
              <b>{SCOPE_LABELS[s]}</b>
              <span>{s === 'full' ? '整块屏幕' : '拖动框出矩形'}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
    <button class="record" on:click={capture} disabled={busy || status.busy}>
      <span class="rec-dot"></span>{busy || status.busy ? '处理中' : '记录'}
      <kbd>{settings?.hotkey ?? shell?.hotkey ?? 'Ctrl+Alt+N'}</kbd>
    </button>
    <button class="auto" class:on={status.auto_enabled} on:click={toggleAuto} title="陪伴模式：看看当前页面，分享理解与灵感，不自动保存">
      陪伴 <span class="auto-track"><i></i></span>
    </button>
    <button class="caption" class:on={captionActive} on:click={toggleCaption} disabled={captionStarting} title="字幕模式：语音转文字 + 屏幕字幕条">
      {captionStarting ? '…' : captionActive ? '字幕中' : '字幕'}
    </button>
    <div class="chip" title={provider.detail}>
      <span class="dot {providerDot}"></span>
      {provider.state === 'ready' ? '模型就绪' : provider.state === 'loading' ? '加载中' : provider.state === 'error' ? '模型异常' : '模型待命'}
    </div>
    <button class="icon" on:click={runSelftest} title="全链路自检">✓</button>
    <button class="icon" on:click={openSettings} title="设置">⚙</button>
  </header>

  <section class="companion-panel" aria-label="页面陪伴" aria-live="polite">
    <div class="companion-top"><strong>{companion?.title || '陪你看看这一页'}</strong><span>{status.auto_enabled ? status.message : '点击陪伴开关可自动看看页面，也可以主动聊聊。'}</span><button class="btn" on:click={chatAboutPage} disabled={companionBusy || status.busy}>{companionBusy ? '正在看页面…' : '聊聊这页'}</button></div>
    <div class="companion-actions">
      <button class="btn ghost" on:click={() => readingAction('show_reading_region')}>正在看哪里</button>
      <button class="btn ghost" on:click={() => readingAction('request_reading_region')}>看错区域了</button>
      <button class="btn ghost" on:click={() => readingAction('clear_reading_region')}>恢复自动选区</button>
      <button class="btn ghost" on:click={async () => { try { await call('companion_feedback',{action:'resume'}); notify('已恢复自动分享'); } catch(e) { fail(e); } }}>恢复分享</button>
      <button class="btn ghost" on:click={() => { showReadiness = true; }}>使用检查</button>
    </div>
    {#if status.last_error}<p role="alert">{status.last_error} <button class="btn" on:click={chatAboutPage} disabled={companionBusy || status.busy}>重试当前页面</button><button class="btn" on:click={openSettings}>检查配置</button></p>{/if}
    {#if companion}
      <p>{companion.page_summary || companion.summary}</p>
      {#if companion.reading_focus?.confidence < .55}<p>这次识别范围不太确定，可以用“看错区域了”手动指定正文。</p>{/if}
      {#if companion.insight}<p class="companion-insight">一点想法：{companion.insight}</p>{/if}
      <button class="btn" disabled={companionBusy || status.busy} on:click={async () => { companionBusy = true; try { const reply = await call<any>('companion_expand', {id:companion.id}); if (reply.skipped) notify(reply.reason); else companion = reply; } catch(e) { notify(String(e), true); } finally { companionBusy = false; } }}>展开讲讲</button>
      <button class="btn" on:click={collectCompanion} disabled={!!companion.note_id}>{companion.note_id ? '已收藏' : '收藏这条灵感'}</button>
      <button class="btn" on:click={async () => { try { await call('companion_feedback', {action:'less'}); notify('本次会话会减少这个话题的提醒'); } catch(e) { notify(String(e), true); } }}>这个话题少说</button>
      <button class="btn" on:click={async () => { try { await call('companion_feedback', {action:'quiet'}); notify('安静十分钟，仍可主动聊聊这页'); } catch(e) { notify(String(e), true); } }}>安静十分钟</button>

    {:else}<p>我会概括页面重点，再分享一点理解。灵感只留在本次会话，喜欢的再收藏。</p>{/if}
  </section>


  {#if captionActive}<div class="caption-status" role="status">{captionProviderName === 'LocalStreamingASR' ? '本地实时字幕' : '字幕正在转写'}{#if captionProviderName === 'OpenAiCompatibleASR'} · 云端识别{/if}{#if waitingAudioMs >= 1000} · 待处理音频 {(waitingAudioMs/1000).toFixed(1)} 秒{/if}{#if failedSegments} · {failedSegments} 段识别失败，可停止后重试{/if}{#if captionQueue > 1} · 尚有 {captionQueue} 段等待处理，屏幕显示将优先跟上当前讲话{/if}{#if captionError} · {captionError}{/if}<button class="btn ghost" on:click={openSettings}>音源与样式</button></div>{/if}
  <div class="body">
    <aside class="sections">
      <div class="side-label">笔记分区</div>
      <div class="section-items">
        <button class="section-item" class:active={activeSection === '全部'} on:click={() => selectSection('全部')}>
          <span class="sname">全部</span><span class="count">{stats.notes_count}</span>
        </button>
        {#each allSections.filter((s) => s.name !== '全部') as s}
          <div class="section-line">
          <button class="section-item" class:active={activeSection === s.name} on:click={() => selectSection(s.name)}>
            <span class="sname">{s.name}</span><span class="count">{s.count}</span>
          </button>
            {#if s.id != null && !s.builtin}
              <span class="sec-ops">
                <button class="mini-btn" on:click|stopPropagation={() => renameSection(s.id!)} title="重命名">✎</button>
                <button class="mini-btn" on:click|stopPropagation={() => deleteSection(s.id!)} title="删除">×</button>
              </span>
            {/if}
          </div>
        {/each}
      </div>
      <button class="section-item drafts" on:click={() => openRecovery().catch(fail)}>
        <span class="sname">草稿与字幕</span><span class="count badge">{pendingDraftsCount}</span>
      </button>
      <div class="side-bottom">
        <div class="side-label">新建分区</div>
        <div class="new-row">
          <input placeholder="名称" bind:value={newSectionName} on:keydown={(e) => e.key === 'Enter' && createSection()} />
          <button on:click={createSection} title="新建分区">＋</button>
        </div>
        <div class="side-hint">一级分区，支持重命名与删除。</div>
      </div>
    </aside>

    <section class="list-pane">
      <div class="list-head">
        <span>{activeSection === '全部' ? '全部笔记' : activeSection}</span>
        <span>{notes.length} 条</span>
      </div>
      <div class="note-list">
        {#if notes.length === 0}
          <div class="empty">
            暂无笔记<br />
            <span>按 <b>{settings?.hotkey ?? 'Ctrl+Alt+N'}</b> 或点「记录」开始</span>
          </div>
        {:else}
          {#each notes as n (n.id)}
            <button class="note-card" class:active={n.id === selectedId} on:click={() => selectNote(n.id)}>
              <div class="nc-thumb">
                {#if n.primary_asset_url}
                  <img class="nc-thumb-img" src={n.primary_asset_url} alt="" loading="lazy" />
                {:else}
                  <span class="nc-img-icon txt">{n.kind === 'transcript' ? '♪' : '文'}</span>
                {/if}
              </div>
              <div class="nc-body">
                <div class="nc-title">{n.summary || (n.kind === 'transcript' ? '会议字幕笔记' : '（无摘要）')}</div>
                <div class="nc-meta">
                  <span>{formatTime(n.created_at)}</span>
                  <span class="tag" class:auto={n.kind === 'auto_promoted'}>{n.kind === 'transcript' ? '字幕' : n.kind === 'auto_promoted' ? '转正' : '手动'}</span>
                  <span class="tag sec">{n.section}</span>
                </div>
              </div>
            </button>
          {/each}
        {/if}
      </div>
    </section>

    <section class="detail">
      {#if detail}
        <div class="detail-head">
          <span class="id-pill">#{detail.id}</span>
          <span class="kind-pill">{detail.kind === 'transcript' ? '字幕' : detail.kind === 'auto_promoted' ? '转正' : '手动'}</span>
          <div class="spacer"></div>
          <button class="btn ghost" on:click={() => (showReview = !showReview)}>{showReview ? '收起文字' : '回看文字'}</button>
        </div>
        <div class="meta-line">
          <span>{formatTime(detail.created_at)}</span>
          <span>{detail.source_app || '未知来源'}</span>
          <span title="来源窗口">{detail.window_title || '未知窗口'}</span>
          <span>{detail.ocr_chars} 字</span>
          <span>{detail.provider}</span>
          <span>{detail.latency_ms} ms</span>
          <select class="section-select" value={detail.section} on:change={(e) => changeSection((e.currentTarget as HTMLSelectElement).value)} title="移动到分区">
            {#each allSections.filter((s) => s.name !== '全部') as s}<option value={s.name}>{s.name}</option>{/each}
          </select>
        </div>

        {#if detailAssets.length > 0}
          <div class="detail-image">
            <img src={detailAssets[0].url} alt="截图" />
          </div>
        {:else if detail.kind === 'transcript'}
          <div class="transcript-preview">{detail.transcript_text || detail.ocr_text || '（无字幕文本）'}</div>
        {:else}
          <div class="empty large">
            <div class="empty-mark">▢</div>
            无截图图片<br />
            <span>这是一条文字笔记</span>
          </div>
        {/if}

        {#if showReview}
          <div class="review-drawer">
            <div class="tabs">
              <button class="tab" class:active={tab === 'summary'} on:click={() => (tab = 'summary')}>摘要</button>
              <button class="tab" class:active={tab === 'ocr'} on:click={() => (tab = 'ocr')}>OCR 原文</button>
              {#if detail.transcript_text}
                <button class="tab" class:active={tab === 'transcript'} on:click={() => (tab = 'transcript')}>字幕</button>
              {/if}
            </div>
            <div class="panel">
              {#if tab === 'summary'}
                <textarea class="summary-input" bind:value={summaryDraft} on:input={() => (dirty = true)} placeholder="摘要"></textarea>
                {#if detail.keywords?.length}
                  <div class="keywords">{#each detail.keywords as k}<span class="kw">{k}</span>{/each}</div>
                {/if}
              {:else if tab === 'ocr'}
                <div class="ocr-view">{detail?.ocr_text || '（未识别到文字）'}</div>
              {:else}
                <div class="ocr-view">{detail.transcript_text || '（无字幕）'}</div>
              {/if}
            </div>
          </div>
        {/if}

        {#if !detail.parse_ok}
          <div class="warnbox">模型输出格式不完整，已保留 OCR 原文与兜底摘要，可手动补充。</div>
        {/if}

        <div class="detail-actions">
          <button class="btn solid" on:click={() => saveNote()} disabled={!dirty}>保存</button>
          <button class="btn" on:click={() => copyText(tab === 'summary' ? summaryDraft : tab === 'ocr' ? (detail?.ocr_text ?? '') : (detail?.transcript_text ?? ''))}>复制</button>
          <button class="btn" on:click={exportNote}>导出 MD</button>
          <button class="btn" on:click={async () => { try { const p = await call<string>('open_note_location',{id:detail.id}); notify(`保存位置：${p}`); } catch(e) { fail(e); } }}>打开保存位置</button>
          <button class="btn danger" on:click={removeNote}>删除</button>
        </div>
      {:else}
        <div class="empty large">
          <div class="empty-mark">▢</div>
          选择左侧笔记查看详情<br />
          <span>默认手动模式：按 <b>{settings?.hotkey ?? 'Ctrl+Alt+N'}</b> 才会记录</span>
        </div>
      {/if}
    </section>
  </div>

  <footer class="statusbar">
    <span><i class="dot {phaseDot}"></i>{status.message}</span>
    <span class="sep"></span>
    <span>后端 <b>{backendName()}</b></span>
    <span>笔记 <b>{stats.notes_count}</b></span>
    <span>OCR <b>{stats.ocr_calls}</b></span>
    <span>总结 <b>{stats.summarize_calls}</b></span>
    <span>跳过 <b>{stats.skipped_no_change}</b></span>
    <span>合并 <b>{stats.merged_notes}</b></span>
    <div class="spacer"></div>
    <span>首次加载 <b>{stats.model_load_ms == null ? '-' : stats.model_load_ms + ' ms'}</b></span>
    <span>最近推理 <b>{stats.last_infer_ms == null ? '-' : stats.last_infer_ms + ' ms'}</b></span>
    <span>全流程 <b>{stats.last_total_ms == null ? '-' : stats.last_total_ms + ' ms'}</b></span>
  </footer>
</div>

{#if showSettings && settingsDraft}
  <div class="overlay" on:click={() => (showSettings = false)} role="presentation">
    <div class="drawer" on:click|stopPropagation on:keydown|stopPropagation tabindex="-1" role="dialog" aria-label="设置">
      <div class="drawer-head"><h2>设置</h2><button class="btn ghost" on:click={() => (showSettings = false)}>关闭</button></div>
      <div class="drawer-body">
        <div class="section-title">记录</div>
        <div class="field">
          <label for="hotkey">全局热键</label>
          <input id="hotkey" class="field-input" bind:value={settingsDraft.hotkey} placeholder="Ctrl+Alt+N" />
          <div class="hint">默认启动为手动模式，只有按热键或点「记录」才会截屏。</div>
        </div>
        <div class="field">
          <label for="scope">默认截屏范围</label>
          <select id="scope" class="field-input" bind:value={settingsDraft.capture_scope}>
            {#each scopes as s}<option value={s}>{SCOPE_LABELS[s]}</option>{/each}
          </select>
          <div class="hint">全屏 / 矩形选区；截屏时自动忽略屏幕笔记自身窗口。</div>
        </div>


        <div class="field">
          <label for="readingmode">页面类型</label>
          <select id="readingmode" class="field-input" bind:value={settingsDraft.reading_mode}>
            <option value="auto">自动判断</option><option value="article">文章网页</option><option value="document">文档 / 双栏 PDF</option><option value="chat">聊天窗口</option><option value="code">代码编辑器</option>
          </select>
        </div>
        <div class="field">
          <label for="pace">陪伴节奏</label>
          <select id="pace" class="field-input" bind:value={settingsDraft.companion_pace}>
            <option value="quiet">安静 · 更少打扰</option>
            <option value="balanced">适中 · 停下来时分享</option>
            <option value="active">活跃 · 更及时回应</option>
          </select>
          <small>自动发言仍会跳过已读内容。“聊聊这页”可随时主动触发。</small>
        </div>
        <div class="field">
          <button class="btn" on:click={async () => { try { await call('clear_companion_memory'); companion = null; notify('本次阅读记忆已清空'); } catch(e) { notify(String(e), true); } }}>清空本次阅读记忆</button>
        </div>

        <div class="field">
          <label for="minsum">陪伴发言最小间隔（秒）</label>
          <input id="minsum" class="field-input" type="number" min="2" max="120" bind:value={settingsDraft.min_summary_interval_secs} />
        </div>

        <div class="field">
          <label for="maxocr">送入模型的最大 OCR 字符数</label>
          <input id="maxocr" class="field-input" type="number" min="200" max="6000" bind:value={settingsDraft.max_ocr_chars} />
        </div>

        <div class="section-title">AI 提供方</div>
        <div class="field">
          <label for="provider">文本总结引擎</label>
          <select id="provider" class="field-input" bind:value={settingsDraft.provider}>
            <option value="OpenAiCompatible">云端 API（DeepSeek / OpenAI 兼容）</option>
            <option value="LocalLlama">本地模型（Qwen2.5-0.5B）</option>
          </select>
          <div class="hint">云端走 DeepSeek 等 OpenAI 兼容接口；本地模型离线可用但能力较弱。</div>
        </div>

        {#if settingsDraft.provider === 'OpenAiCompatible'}
          <div class="provider-box">
            <div class="row" style="justify-content:space-between">
              <b>文本总结 API</b>
              <span class="pill {provider.state === 'ready' ? 'ok' : provider.state === 'error' ? 'err' : 'warn'}">{provider.state}</span>
            </div>
            <div class="field">
              <label for="api_base">Base URL</label>
              <input id="api_base" class="field-input" bind:value={settingsDraft.api_config.base_url} placeholder="https://api.deepseek.com/v1" />
            </div>
            <div class="field">
              <label for="api_key">API Key</label>
              <input id="api_key" class="field-input" type="password" bind:value={settingsDraft.api_config.api_key} placeholder="sk-..." />
            </div>
            <div class="field">
              <label for="api_model">模型名</label>
              <input id="api_model" class="field-input" bind:value={settingsDraft.api_config.model} placeholder="deepseek-chat" />
            </div>
            <div class="hint" style="margin:4px 0 0">{provider.detail}</div>
          </div>
        {:else}
          <div class="provider-box">
            <div class="row" style="justify-content:space-between">
              <b>LocalLlama · Qwen2.5-0.5B Q4_K_M</b>
              <span class="pill {provider.state === 'ready' ? 'ok' : provider.state === 'error' ? 'err' : 'warn'}">{provider.state}</span>
            </div>
            <div class="hint" style="margin:8px 0">{provider.detail}</div>
            <div class="row" style="flex-wrap:wrap;gap:6px">
              <span class="pill">OCR：{provider.ocr_language}</span>
              <span class="pill">端口：{provider.port ?? '-'}</span>
              <span class="pill">加载：{provider.load_ms ?? '-'} ms</span>
              <span class="pill">推理：{provider.last_infer_ms ?? '-'} ms</span>
            </div>
            <div class="row" style="margin-top:10px"><button class="btn" on:click={startModel}>启动 / 检查模型</button></div>
          </div>
        {/if}

        <div class="section-title">语音识别（ASR）</div>
        <div class="provider-box">
          <div class="row" style="justify-content:space-between"><b>语音转文字 API</b><span class="pill warn">OpenAI 兼容</span></div>
          <div class="hint" style="margin:6px 0">云端模式使用此接口转写音频，本地中文模式无需联网。</div>
          <div class="field">
            <label for="asr_base">Base URL</label>
            <input id="asr_base" class="field-input" bind:value={settingsDraft.asr_config.base_url} placeholder="https://api.siliconflow.cn/v1" />
          </div>
          <div class="field">
            <label for="asr_key">API Key</label>
            <input id="asr_key" class="field-input" type="password" bind:value={settingsDraft.asr_config.api_key} placeholder="sk-..." />
          </div>
          <div class="field">
            <label for="asr_model">模型名</label>
            <input id="asr_model" class="field-input" bind:value={settingsDraft.asr_config.model} placeholder="FunAudioLLM/SenseVoiceSmall" />
          </div>
        </div>

        <div class="section-title">屏幕字幕条</div>
        <div class="field"><label for="caption-engine">识别方式</label><select id="caption-engine" class="field-input" bind:value={settingsDraft.caption_engine}><option value="auto">自动 · 中文优先本地</option><option value="cloud">云端 API</option><option value="local">本地实时 · 中文流式</option></select><small>自动模式在中文配置且本地组件就绪时边听边显示，其余情况使用云端。下次开始字幕生效。</small></div>
        <div class="field"><button class="btn" disabled={localAsr?.state === 'installing'} on:click={installLocalAsr}>{localAsr?.ready ? '重新检查 / 安装本地组件' : '安装本地识别组件'}</button><p role="status">{localAsr?.detail ?? '本地组件未安装'}</p>{#if localAsr?.state === 'installing'}<progress max="100" value={localAsr.percent ?? 0}></progress>{/if}</div>
        <div class="field"><label for="caption-profile">云端处理档位</label><select id="caption-profile" class="field-input" bind:value={settingsDraft.caption_processing.profile}><option value="balanced">均衡 · 保留更多上下文</option><option value="fast">低延迟 · 较短分段</option></select><small>短分段会增加请求次数，准确率取决于接口和音频。</small></div>
        <div class="field"><label for="caption-concurrency">云端最大并发</label><select id="caption-concurrency" class="field-input" bind:value={settingsDraft.caption_processing.concurrency}><option value={1}>1 · 顺序请求</option><option value={2}>2 · 有限并发</option></select></div>
        <div class="field">
          <div><button class="btn" disabled={captionStarting || (captionActive && !testingCaption)} on:click={testCaptionSpeed}>{testingCaption && captionActive ? '结束测试并回看' : '测试字幕速度'}</button></div>
          <small>{testingCaption && captionActive ? '现在说一句话，或播放一段语音，观察屏幕字幕。' : '使用已保存的识别方式和音源。保存新设置后可再次比较。'}</small>
          {#if captionTiming}
            <small>{captionTiming.source === 'microphone' ? '麦克风' : '系统声音'} · {captionTiming.provider === 'LocalStreamingASR' ? '本地中文流式' : '云端语音识别'}</small>
            <small>启动 {timingText(captionTiming.startup_ms)} · 首次识别 {timingText(captionTiming.first_text_ms)} · 首行绘制 {timingText(captionTiming.first_paint_ms)}</small>
            {#if captionTiming.first_submit_ms !== null}<small>首次提交 {timingText(captionTiming.first_submit_ms)}</small>{/if}
            <small>首次定稿 {timingText(captionTiming.first_final_ms)} · 结果到绘制 {timingText(captionTiming.paint_delay_ms)}{#if captionTiming.stop_ms !== null} · 收尾 {timingText(captionTiming.stop_ms)}{/if}</small>
            {#if !captionTiming.heard_sound && captionActive}<small>等待有声输入，请检查当前音源。</small>{/if}
          {/if}
        </div>
        <div class="field"><label for="audiosource">字幕音源</label><select id="audiosource" class="field-input" bind:value={settingsDraft.audio_source}><option value="loopback">电脑播放的声音</option><option value="microphone">默认麦克风</option></select><small>保存后在下次开始字幕时生效；麦克风设备在 Windows 声音设置中选择。</small></div>
        <div class="companion-actions"><button class="btn" on:click={() => presetCaption('contrast')}>高对比</button><button class="btn" on:click={() => presetCaption('large')}>大字</button><button class="btn" on:click={() => presetCaption('default')}>恢复默认样式</button></div>
        <div class="caption-preview" style:color={settingsDraft.caption_style?.font_color} style:background={settingsDraft.caption_style?.background ? settingsDraft.caption_style?.bg_color : '#F3F5F8'} style:font-size={`${settingsDraft.caption_style?.font_size ?? 28}px`}>陪你看看这一页 · 字幕预览</div>
        <div class="provider-box">
          <div class="hint" style="margin:0 0 8px">字幕模式下屏幕底部的悬浮字幕：淡灰底白字，可调大小、字体颜色与是否带背景。</div>
          <div class="field">
            <label for="caption_font_size">字体大小（12–72）</label>
            <input id="caption_font_size" class="field-input" type="number" min="12" max="72" bind:value={settingsDraft.caption_style.font_size} />
          </div>
          <div class="field">
            <label for="caption_font_color">字体颜色</label>
            <input id="caption_font_color" class="field-input" type="color" bind:value={settingsDraft.caption_style.font_color} />
          </div>
          <div class="field">
            <label for="caption_background">背景开关</label>
            <input id="caption_background" type="checkbox" bind:checked={settingsDraft.caption_style.background} /> 淡灰底（半透明）
          </div>
          {#if settingsDraft.caption_style.background}
            <div class="field">
              <label for="caption_bg_color">背景颜色</label>
              <input id="caption_bg_color" class="field-input" type="color" bind:value={settingsDraft.caption_style.bg_color} />
            </div>
            <div class="field">
              <label for="caption_opacity">背景不透明度（{settingsDraft.caption_style.opacity}%）</label>
              <input id="caption_opacity" class="field-input" type="range" min="20" max="100" bind:value={settingsDraft.caption_style.opacity} />
            </div>
          {/if}
          <div class="field">
            <label for="caption_visible">字幕条显示</label>
            <input id="caption_visible" type="checkbox" bind:checked={settingsDraft.caption_style.visible} /> 显示字幕条
          </div>
        </div>

        <div class="section-title">数据</div>
        <div class="field">
          <label for="data_dir">笔记数据目录</label>
          <div class="row">
            <input class="field-input" id="data_dir" readonly value={settings?.data_dir ?? ''} />
            <button class="btn" on:click={openDataDir}>打开</button>
          </div>
        </div>
        <button class="btn solid wide" on:click={saveSettings}>保存设置</button>
      </div>
    </div>
  </div>
{/if}

{#if showReport && report}
  <div class="overlay" on:click={() => (showReport = false)} role="presentation">
    <div class="drawer" on:click|stopPropagation on:keydown|stopPropagation tabindex="-1" role="dialog" aria-label="自检报告">
      <div class="drawer-head"><h2>自检报告 {report.passed ? '✓' : '✕'}</h2><button class="btn ghost" on:click={() => (showReport = false)}>关闭</button></div>
      <div class="drawer-body report">
        <div class="hint" style="margin-bottom:12px">总耗时 {report.elapsed_ms} ms，共 {report.results.length} 项。</div>
        {#each report.results as r}
          <div class="report-item">
            <span class="pill {r.ok ? 'ok' : 'err'}">{r.ok ? 'PASS' : 'FAIL'}</span>
            <div style="flex:1"><b>{r.name}</b><div class="hint">{r.detail}</div></div>
            <span class="hint">{r.duration_ms} ms</span>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

{#if showDraftPicker}
  <div class="overlay" role="presentation">
    <div class="drawer" on:click|stopPropagation on:keydown|stopPropagation tabindex="-1" role="dialog" aria-label="选择分区">
      <div class="drawer-head"><h2>保存到分区</h2></div>
      <div class="drawer-body">
        <div class="hint" style="margin-bottom:12px">草稿已生成，选择分区后才成为正式笔记（关闭不丢，可在「待归档」恢复）。</div>
        <button class="btn solid wide" disabled={recoveryBusy} on:click={() => commitDraftTo(null)}>收集箱</button>
        {#each sectionRows.filter((s) => !s.builtin) as s}
          <button class="btn wide" disabled={recoveryBusy} style="margin-top:8px" on:click={() => commitDraftTo(s.id)}>{s.name}</button>
        {/each}
        <div class="row" style="margin-top:16px;gap:8px">
          <button class="btn ghost" disabled={recoveryBusy} on:click={discardPendingDraft}>丢弃草稿</button>
          <button class="btn ghost" disabled={recoveryBusy} on:click={() => { showDraftPicker = false; notify('草稿已保留，可在待归档入口恢复'); }}>稍后处理</button>
        </div>
      </div>
    </div>
  </div>
{/if}


{#if showRecovery}
  <div class="overlay" role="presentation">
    <div class="drawer" tabindex="-1" role="dialog" aria-modal="true" aria-label="草稿与字幕">
      <div class="drawer-head"><h2>草稿与字幕</h2><button class="btn" disabled={recoveryBusy} on:click={() => { showRecovery = false; reviewSession = null; savedCaptionNoteId = null; }}>关闭</button></div>
      <div class="drawer-body">
        {#if savedCaptionNoteId}
          <div class="recovery-row"><p>字幕笔记已保存。</p><button class="btn" on:click={async () => { try { await call('open_note_location', {id:savedCaptionNoteId}); } catch(e) { fail(e); } }}>打开保存位置</button></div>
        {/if}
        <h3>待归档草稿</h3>
        {#each drafts.filter(d => d.status === 'pending') as d}
          <div class="recovery-row"><p>{d.ocr_clean || d.ocr_raw || '图片草稿'}</p><button class="btn" on:click={() => { pendingDraftId = d.id; showRecovery = false; showDraftPicker = true; }}>选择分区并保存</button></div>
        {:else}<p class="hint">没有待归档草稿。</p>{/each}
        <h3>待处理字幕</h3>
        {#each captionSessions as s}
          <button class="btn" on:click={() => reviewCaption(s.id)}>会话 #{s.id} · {formatTime(s.started_at)}</button>
        {:else}<p class="hint">没有待处理字幕。停止字幕后可在此保存。</p>{/each}
        {#if reviewSession}
          <h3>会话 #{reviewSession.id}</h3>
          {#if captionTiming?.session_id === reviewSession.id}
            <p class="hint">首次识别 {timingText(captionTiming.first_text_ms)} · 首行绘制 {timingText(captionTiming.first_paint_ms)} · 收尾 {timingText(captionTiming.stop_ms)}</p>
          {/if}
          {#if reviewSession.issues?.length}
            <div role="alert"><p>有 {reviewSession.issues.length} 段音频未能识别，以下时间范围可能缺少文字：</p>{#each reviewSession.issues as issue}<p>{(issue.start_ms/1000).toFixed(1)}–{(issue.end_ms/1000).toFixed(1)} 秒：{issue.message}</p>{/each}
            <button class="btn" disabled={recoveryBusy || !reviewSession.retry_available} on:click={async () => { recoveryBusy=true;try { await call('retry_caption_segments',{session_id:reviewSession.id});await reviewCaption(reviewSession.id); } catch(e) {fail(e);}finally{recoveryBusy=false;} }}>重试失败片段</button>
            <label><input type="checkbox" bind:checked={incompleteCaption} /> 我了解有缺失，保存已识别内容</label></div>
          {/if}
          <p class="hint">选择保存分区后，可保存全场或勾选的片段。保存时自动整理标点和段落，原始转写保留供回看。</p>
          {#if recoveryBusy}<p role="status">正在处理，请稍候…</p>{/if}
          {#each reviewSession.transcripts as t}
            <label class="recovery-row"><input type="checkbox" checked={!!t.selected} disabled={recoveryBusy} on:change={(e) => markTranscript(t.id, e.currentTarget.checked)} /> {t.text}</label>
          {:else}<p class="hint">尚未识别到字幕。请检查声音播放和 ASR 配置。</p>{/each}
          <label>保存分区 <select bind:value={captionSection}><option value={null}>收集箱</option>{#each sectionRows.filter(s => s.name !== '收集箱') as s}<option value={s.id}>{s.name}</option>{/each}</select></label>
          <div class="drawer-actions">
            <button class="btn solid" disabled={recoveryBusy || !reviewSession.transcripts.length} on:click={() => saveCaption('full')}>保存全场</button>
            <button class="btn" disabled={recoveryBusy || !reviewSession.transcripts.some((t: any) => t.selected)} on:click={() => saveCaption('selected')}>保存已选</button>
            <button class="btn danger" disabled={recoveryBusy} on:click={() => saveCaption('discard')}>丢弃会话</button>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if toast}
  <div class="toast" class:err={toastErr}>{toast}</div>
{/if}

{#if showReadiness}
  <div class="overlay" role="presentation">
    <div class="drawer" role="dialog" tabindex="-1" aria-modal="true" aria-label="开始使用与检查">
      <div class="drawer-head"><h2>开始使用与检查</h2><button class="btn" disabled={readinessBusy} on:click={async () => { try { await call('complete_onboarding'); showReadiness = false; } catch(e) { fail(e); } }}>进入软件</button></div>
      <div class="drawer-body">
        <p>打开陪伴后，我会等你停下来阅读，再分享页面重点和一点理解。喜欢的灵感可以收藏。</p>
        <p>字幕支持电脑播放声音或默认麦克风。停止后可回看、选择片段并保存到分区。</p>
        <div class="companion-actions"><button class="btn" disabled={readinessBusy} on:click={() => checkReady()}>检查屏幕与配置</button><button class="btn" disabled={readinessBusy} on:click={() => checkReady(true)}>测试接口连接</button><button class="btn" disabled={readinessBusy} on:click={() => checkReady(false,true)}>测试音源</button></div>
        <p>接口测试会发送公开测试文字和静音音频；音源测试只在本机采集，不保存或上传。</p>
        {#if readinessBusy}<p role="status">正在逐项检查，请稍候…</p>{/if}
        {#each readiness?.checks ?? [] as item}
          <div class="recovery-row"><strong>{item.title} · {item.state === 'pending' ? '待测试' : item.ok ? '可用 / 已检查' : '需要处理'}</strong><p>{item.detail}</p>{#if !item.ok}<p>{item.recovery}</p>{/if}</div>
        {/each}
        <button class="btn" on:click={async () => { showReadiness = false; await openSettings(); }}>打开设置</button>
      </div>
    </div>
  </div>
{/if}
