import { focusFingerprint } from './reading.mjs';
import { pacing } from './companion.mjs';
export function createCompanionController(core, deps) {
 const { AUTO_CHECK_MS, AUTO_MAX_LEVEL, AUTO_STABLE_MS, AUTO_TICK_MS, clamp, fpDiff } = deps;
 return {
  startAuto() {
    core.companionSession().invalidate();
    core.settings.auto_enabled = true;
    core.status.auto_enabled = true;
    core.autoStopping = false;
    core.autoLevel = 0;
    core.quietFrames = 0;
    core.nextCheckAt = 0;
    core.lastChangeAt = 0;
    core.lastFingerprint = null;
    core.lastAutoOcrText = '';
    core.lastOcrHash = '';
    core.lastForegroundAt = 0;
    core.lastAutoAt = 0;
    core.autoObserveSince = Date.now();
    core.forceProcess = false;
    core.changeBoostUntil = 0;
    if (core.autoTimer) return;
    // One cheap timer for the whole session. The real work is paced by
    // nextCheckAt, so a quiet page costs almost nothing and a change still
    // gets picked up on the very next tick. Every tick runs inside the SAME
    // serial chain as manual captures, so a 250 ms tick can never grab a frame
    // that a manual capture (or another tick) is still using.
    core.autoTimer = setInterval(() => {
      core.autoTick().catch((e) => core.setError(e));
    }, AUTO_TICK_MS);
    core.status.message = '陪伴已开启，正在看看当前页面';
  },
  async stopAuto() {
    if (!core.settings.auto_enabled && !core.autoTimer) return;
    core.companionSession().invalidate();
    core.shellQueue = core.shellQueue.filter(c => c.type !== 'auto_note');
    core.autoStopping = true;
    core.settings.auto_enabled = false;
    core.status.auto_enabled = false;
    core.autoLevel = 0;
    core.nextCheckAt = 0;
    if (core.autoTimer) { clearInterval(core.autoTimer); core.autoTimer = null; }
    // 等待已经入队的 auto/manual 捕获全部完成，之后再碰 helper 帧。
    await core._captureChain.catch(() => {});
    if (core.initialized) {
      try { await core.win.request('clear'); } catch { /* helper may be closing */ }
    }
    core.autoStopping = false;
    core.busy = false;
    core.setPhase('idle', '陪伴已暂停，点开关可继续');
  },
  async autoTick() {
    if (!core.settings.auto_enabled || core.autoStopping || core.busy || !core.initialized) return;
    // 整段 tick 纳入串行链：抓帧、判定、OCR、总结、清帧一气呵成，绝不与手动
    // 捕获交错。链内先做一次停止标志复核，避免关闭后排队的 tick 继续执行。
    if (core._autoTickPending) return;
    core._autoTickPending = true;
    try { return await core._runSerial(() => core._autoTickInner()); }
    finally { core._autoTickPending = false; }
  },
  async _autoTickInner() {
    if (!core.settings.auto_enabled || core.autoStopping || !core.initialized) return;
    // 手动两阶段捕获正在持有 helper 帧时，auto 不得抓帧覆盖它。
    if (core._selectingReadingRegion && Date.now()-core._selectingReadingRegion<120000) return;
    if (Date.now() < core.companionSession().quietUntil) { core.status.message='安静陪伴中，仍可主动聊聊这页';return; }
    if (core.manualFrameHeld && Date.now() - core.manualFrameHeld < 120000) return;
    const now = Date.now();
    if (core.lastTickTime && now-core.lastTickTime>15000) { core.lastForegroundAt=0;core.readingFocus=null;core.lastFingerprint=null;core.autoObserveSince=now;core.nextCheckAt=0; }
    core.lastTickTime=now;
    if (now < core.nextCheckAt) return; // adaptive back-off, near-zero cost
    if (core.captionSession && core._captionControl?.waitingAudioMs() >= 3500) {
      core.status.message = '字幕正在追赶音频，陪伴稍后查看当前页面';
      core.nextCheckAt = now + 1000;
      return;
    }

    const rhythm = pacing(core.settings.companion_pace);
    const level = core.autoLevel;
    core.nextCheckAt = now + AUTO_CHECK_MS[level];
    core.stats.adaptive_checks++;

    // Foreground window barely changes on one page: query at most every 2 s
    // instead of on every grab. This is the biggest single saving.
    if (!core.lastForegroundAt || now - core.lastForegroundAt > 2000) {
      try {
        core.lastForegroundInfo = (await core.win.request('foreground')) || {};
        core.lastForegroundAt = now;
      } catch { core.lastForegroundInfo = {}; }
    }
    if (core.isSelfForeground(core.lastForegroundInfo)) {
      core.status.internal_foreground = true;
      core.status.message = '正在自己的收藏库，陪伴暂候';
      return;
    }
    core.status.internal_foreground = false;

    const snap = await core.win.request('snap');
    if (!core.settings.auto_enabled) {
      await core.win.request('clear');
      return;
    }
    const diff = fpDiff(core.lastFingerprint, snap.fingerprint);
    const scope = core.lastForegroundInfo.process + '|' + core.lastForegroundInfo.title;
    if (core.readingFocus?.scope === scope && core.readingFocus.signature === JSON.stringify(core.lastForegroundInfo.bounds ?? null) && (!snap.width || snap.width === core.readingFocus.width) && (!snap.height || snap.height === core.readingFocus.height)) {
      const focused = focusFingerprint(snap.fingerprint, core.readingFocus.rect, core.readingFocus.width, core.readingFocus.height);
      if (focused && core.lastReadingFingerprint && fpDiff(core.lastReadingFingerprint, focused) <= 0.8 && now - core.lastReadingCheck < 30000) {
        core.lastFingerprint = snap.fingerprint;
        core.stats.skipped_no_change++; core.status.message = '正文没有变化，忽略周边动画与固定区域';
        core.autoLevel = Math.min(AUTO_MAX_LEVEL, core.autoLevel + 1);
        await core.win.request('clear'); return;
      }
    }
    core.lastFingerprint = snap.fingerprint;

    core.autoObserveSince ||= now;
    if (diff > 3 && now - core.autoObserveSince < rhythm.maxWait) {
      // A visual change gives a short responsiveness boost, but must NOT erase
      // the quiet level: a scrolling terminal changes pixels every tick while
      // the text stays the same. The OCR similarity gate makes the final call.
      core.lastChangeAt = now;
      core.forceProcess = true;
      // A boost is never renewed: a continuously changing screen must not keep
      // the scheduler pinned to its fastest tier forever.
      if (now > core.changeBoostUntil) { core.changeBoostUntil = now + 3000; }
      core.nextCheckAt = now + AUTO_CHECK_MS[Math.min(core.autoLevel, 1)];
      await core.win.request('clear');
      return;
    }
    const boosted = now < core.changeBoostUntil;
    const stableMs = Math.max(rhythm.dwell, boosted ? AUTO_STABLE_MS[0] : AUTO_STABLE_MS[level]);
    if (!core.lastChangeAt) core.lastChangeAt = now;
    if (now - core.lastChangeAt < stableMs && now - core.autoObserveSince < rhythm.maxWait) {
      await core.win.request('clear');
      return;
    }

    // Near-identical frames mean we are probably still on the same page:
    // climb one tier every two quiet checks, which stretches both the grab
    // interval (up to 6 s) and the processing cooldown (up to 45 s).
    if (diff <= 1.2) {
      core.quietFrames++;
      if (core.quietFrames >= 2 && core.autoLevel < AUTO_MAX_LEVEL) {
        core.autoLevel++;
        core.quietFrames = 0;
      }
    } else {
      core.quietFrames = 0; // cursor blink / animation: hold the current tier
    }

    const gapMs = Math.max(rhythm.interval, clamp(core.settings.min_summary_interval_secs, 3, 120, 10) * 1000);
    if (now - core.lastAutoAt < gapMs) {
      await core.win.request('clear');
      return;
    }
    // 关闭信号可能在抓帧/判定期间到达，入队执行前再复核一次。
    if (!core.settings.auto_enabled || core.autoStopping) {
      await core.win.request('clear');
      return;
    }
    core.lastChangeAt = 0;
    core.lastAutoAt = now;
    core.autoObserveSince = now;
    const force = core.forceProcess;
    core.forceProcess = false;
    // 已在串行链内，直接执行捕获；用 _captureWithAutoEvent 保证 auto 笔记
    // 照常发气泡事件，但不能再调用 captureOnce（那会再排一层链导致死锁）。
    await core._captureWithAutoEvent('auto', { snap, forceProcess: force });
    // We just read this screen; give it at least one tier of cooldown so a
    // noisy desktop cannot trigger two model runs in quick succession.
    if (core.autoLevel < 1) core.autoLevel = 1;
  }
 };
}
