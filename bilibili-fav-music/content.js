// content.js - 仅在被设为“听歌专属标签页”的那 1 个标签页内生效，绝不修改 B 站全局设置或其他标签页

(() => {
  // 标签页级持久化存储 key（页面刷新、被浏览器休眠丢弃后重新加载，sessionStorage 依然保留）
  const SS_TAB_CLAIM_KEY = "__bili_fav_music_tab_claim__";
  const SS_PROGRESS_KEY = "__bili_fav_music_track_progress__";

  let isMusicTab = false;
  let playMode = "shuffle";
  let currentTrack = null;

  let trackedVideo = null;
  let lastUrl = location.href;
  let trackEndTriggered = false;
  let userManuallyPaused = false;
  let userManuallySeeked = false;
  let trackLoadWallTime = 0;
  let autoPlayDeadline = 0;
  let badgeEl = null;

  // —— 防回拉与断点续播状态 ——
  let currentTrackKey = null;
  // 这一首是否已经真正播起来过（或从同一首歌的休眠/刷新中恢复）；一旦为 true，绝不再回拉 00:00
  let playbackStarted = false;
  // 这一首的“B站历史进度”判定是否已结束（每首歌只判定一次）
  let historySeekChecked = false;
  // 当前曲目在本标签页内的实时最高有效播放进度：{ key, time, paused, updatedAt }
  let activeProgress = null;
  let lastProgressReportAt = 0;

  const MODE_LABELS = {
    shuffle: "🔀 随机播放",
    order: "🔁 列表循环",
    loop: "🔂 单曲循环"
  };

  function hasSessionTabClaim() {
    try {
      return sessionStorage.getItem(SS_TAB_CLAIM_KEY) === "1";
    } catch {
      return false;
    }
  }

  function setSessionTabClaim(enabled) {
    try {
      if (enabled) {
        sessionStorage.setItem(SS_TAB_CLAIM_KEY, "1");
      } else {
        sessionStorage.removeItem(SS_TAB_CLAIM_KEY);
        sessionStorage.removeItem(SS_PROGRESS_KEY);
      }
    } catch {
      // ignore
    }
  }

  function readSavedProgress(expectedKey) {
    try {
      const raw = sessionStorage.getItem(SS_PROGRESS_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object") return null;
      if (expectedKey && data.key !== expectedKey) return null;
      if (!Number.isFinite(data.time) || data.time < 0) return null;
      return data;
    } catch {
      return null;
    }
  }

  function saveProgress(key, time, paused, { reportToBg = false } = {}) {
    if (!key || !Number.isFinite(time) || time < 0) return;
    const record = {
      key,
      time,
      paused: Boolean(paused),
      updatedAt: Date.now()
    };
    activeProgress = record;
    try {
      sessionStorage.setItem(SS_PROGRESS_KEY, JSON.stringify(record));
    } catch {
      // ignore
    }
    const now = Date.now();
    if (reportToBg || now - lastProgressReportAt > 4000) {
      lastProgressReportAt = now;
      try {
        chrome.runtime.sendMessage({
          type: "REPORT_PROGRESS",
          key,
          time,
          paused: Boolean(paused)
        });
      } catch {
        // ignore
      }
    }
  }

  function clearSavedProgress() {
    activeProgress = null;
    try {
      sessionStorage.removeItem(SS_PROGRESS_KEY);
    } catch {
      // ignore
    }
  }

  function markManualInteraction(e) {
    if (!isMusicTab || !trackedVideo) return;
    if (e.type === "keydown") {
      if (e.code === "Space" || e.key === "k" || e.key === "K") {
        userManuallyPaused = !trackedVideo.paused;
        if (currentTrackKey && Number.isFinite(trackedVideo.currentTime)) {
          saveProgress(currentTrackKey, trackedVideo.currentTime, userManuallyPaused, { reportToBg: true });
        }
      } else if (e.code === "ArrowRight" || e.code === "ArrowLeft") {
        userManuallySeeked = true;
      }
    } else if (e.type === "pointerdown") {
      const target = e.target;
      if (target && target.closest) {
        if (target.closest(".bpx-player-progress-wrap, .bpx-player-progress")) {
          userManuallySeeked = true;
        } else if (target.closest(".bpx-player-video-wrap, .bpx-player-ctrl-play")) {
          userManuallyPaused = !trackedVideo.paused;
          if (currentTrackKey && Number.isFinite(trackedVideo.currentTime)) {
            saveProgress(currentTrackKey, trackedVideo.currentTime, userManuallyPaused, { reportToBg: true });
          }
        }
      }
    }
  }

  window.addEventListener("keydown", markManualInteraction, true);
  window.addEventListener("pointerdown", markManualInteraction, true);

  // 从当前 URL 里取出“这首歌是谁”的标识：BV 号 + 分P
  function trackKeyFromUrl(urlStr) {
    try {
      const u = new URL(urlStr || location.href);
      const m = u.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i);
      if (!m) return null;
      const p = Number(u.searchParams.get("p") || 1) || 1;
      return `${m[1]}:${p}`;
    } catch {
      return null;
    }
  }

  // 同步当前曲目锚点：
  // - 如果 sessionStorage 里已经有同一首歌的播放进度（> 2秒），说明是“切回标签页触发了刷新 / 休眠唤醒”，
  //   不是新切了一首歌！此时直接把 playbackStarted 和 historySeekChecked 置为 true，严禁拉回 00:00。
  // - 只有真正换到了另一首歌时，才清空旧进度并允许首次从 00:00 开播。
  function syncTrackAnchor(urlStr, bgProgress = null) {
    const key = trackKeyFromUrl(urlStr);
    if (!key) return false;
    const isSameKey = key === currentTrackKey;

    let saved = readSavedProgress(key);
    if (!saved && bgProgress && bgProgress.key === key && Number.isFinite(bgProgress.time)) {
      saved = bgProgress;
    }

    if (isSameKey) {
      if (saved && saved.time > 2) {
        playbackStarted = true;
        historySeekChecked = true;
      }
      return false;
    }

    currentTrackKey = key;
    trackLoadWallTime = Date.now();

    if (saved && saved.time > 2) {
      // 同一首歌被刷新/休眠唤醒：继承已播状态与暂停状态，绝不回拉 0 点
      activeProgress = saved;
      playbackStarted = true;
      historySeekChecked = true;
      if (saved.paused) {
        userManuallyPaused = true;
      }
    } else {
      // 真正换了一首新歌：清空上一首的进度，准备从 00:00 开始
      clearSavedProgress();
      historySeekChecked = false;
      playbackStarted = false;
    }
    return true;
  }

  // 如果这首歌是在播放途中因为切回标签页/播放器重建/页面刷新导致进度丢失归零，自动恢复到刚才的进度
  function restoreInterruptedProgressIfNeeded(video) {
    if (!isMusicTab || !video || userManuallySeeked || trackEndTriggered) return false;
    const saved = (activeProgress && activeProgress.key === currentTrackKey)
      ? activeProgress
      : readSavedProgress(currentTrackKey);
    if (!saved || saved.key !== currentTrackKey || !Number.isFinite(saved.time) || saved.time <= 3) {
      return false;
    }
    if (Number.isFinite(video.duration) && video.duration > 5 && saved.time >= video.duration - 1.5) {
      return false;
    }
    // 当前播放器处于开头（< 2 秒），而我们已经记下了这首歌播到了 saved.time（> 3 秒），立刻恢复过去
    if (Number.isFinite(video.currentTime) && video.currentTime < 2 && Math.abs(video.currentTime - saved.time) > 2.5) {
      try {
        video.currentTime = saved.time;
        playbackStarted = true;
        historySeekChecked = true;
        return true;
      } catch {
        // ignore
      }
    }
    return false;
  }

  // 如果在刚切到一首新歌时，B站自动恢复了以前看过的历史进度，强制拉回 00:00 从头播放
  function enforceStartFromZero(video) {
    if (!isMusicTab || !video || userManuallySeeked) return false;
    // 如果这首歌在当前听歌会话里已经有进度记录（比如切标签页刷新了），优先恢复进度，绝不拉回 00:00
    const saved = (activeProgress && activeProgress.key === currentTrackKey)
      ? activeProgress
      : readSavedProgress(currentTrackKey);
    if (saved && saved.key === currentTrackKey && saved.time > 2) {
      playbackStarted = true;
      historySeekChecked = true;
      restoreInterruptedProgressIfNeeded(video);
      return false;
    }
    if (playbackStarted || historySeekChecked) return false;
    const elapsedSinceLoadSec = (Date.now() - trackLoadWallTime) / 1000;
    if (elapsedSinceLoadSec > 12) {
      historySeekChecked = true;
      return false;
    }
    if (!Number.isFinite(video.currentTime) || video.currentTime <= 0) return false;
    if (!Number.isFinite(video.duration) || video.duration <= 5) return false;
    const rate = Number.isFinite(video.playbackRate) && video.playbackRate > 1 ? Math.min(video.playbackRate, 8) : 1;
    const maxLegitSec = elapsedSinceLoadSec * rate + 2;
    if (video.currentTime > Math.max(3, maxLegitSec)) {
      try {
        video.currentTime = 0;
        historySeekChecked = true;
      } catch {
        // ignore
      }
      return true;
    }
    return false;
  }

  function tryAutoPlay(video) {
    if (!isMusicTab || !video || trackEndTriggered || userManuallyPaused) return;
    if (!restoreInterruptedProgressIfNeeded(video)) {
      enforceStartFromZero(video);
    }
    if (video.paused) {
      video.play().catch(() => {
        // 如果浏览器策略短暂拦截，稍后重试
      });
    }
  }

  function handleTrackFinished(video) {
    if (!isMusicTab || trackEndTriggered) return;
    // 防止B站历史记录刚好停在片尾最后一秒、刚打开新歌页面就误判为播放结束
    if (enforceStartFromZero(video)) {
      tryAutoPlay(video);
      return;
    }
    trackEndTriggered = true;
    // 这首歌正常播完了，清除它的中途断点记录（这样如果单曲循环或下一轮再抽到它，会正常从 00:00 开始）
    clearSavedProgress();

    if (playMode === "loop") {
      try {
        video.currentTime = 0;
        video.play().catch(() => {});
      } catch {
        // ignore
      }
      setTimeout(() => {
        trackEndTriggered = false;
      }, 1000);
      return;
    }

    try {
      video.pause();
    } catch {
      // ignore
    }

    chrome.runtime.sendMessage({ type: "TRACK_ENDED" }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res?.action === "REPLAY_CURRENT" && video) {
        video.currentTime = 0;
        video.play().catch(() => {});
        setTimeout(() => {
          trackEndTriggered = false;
        }, 1000);
      }
    });
  }

  // 在捕获阶段拦截 video 的 ended 事件，防止B站原生播放器触发分P切换或合集连播
  window.addEventListener(
    "ended",
    (e) => {
      if (!isMusicTab) return;
      if (e.target && e.target.tagName === "VIDEO") {
        e.stopImmediatePropagation();
        e.stopPropagation();
        handleTrackFinished(e.target);
      }
    },
    true
  );

  function onTimeUpdate(e) {
    if (!isMusicTab) return;
    const video = e.currentTarget;
    if (!video) return;

    // 只要已经在正常往前播放（超过 1.2 秒）且通过了最初的历史进度检查，就实时记下当前进度
    if (!video.paused && Number.isFinite(video.currentTime) && video.currentTime > 1.2) {
      if (!enforceStartFromZero(video)) {
        playbackStarted = true;
        historySeekChecked = true;
        if (currentTrackKey) {
          saveProgress(currentTrackKey, video.currentTime, false);
        }
      }
    }

    if (trackEndTriggered) return;
    if (!Number.isFinite(video.duration) || video.duration <= 3) return;
    const remaining = video.duration - video.currentTime;
    // 在视频结束前 0.4 秒提前接管切歌，彻底避开B站片尾自动跳合集/分P或充电鸣谢遮罩
    if (remaining <= 0.4 && video.currentTime > 1) {
      handleTrackFinished(video);
    }
  }

  function onSeeking(e) {
    if (!isMusicTab || trackEndTriggered) return;
    const video = e.currentTarget;
    if (!video) return;
    if (userManuallySeeked && currentTrackKey && Number.isFinite(video.currentTime)) {
      playbackStarted = true;
      historySeekChecked = true;
      saveProgress(currentTrackKey, video.currentTime, video.paused, { reportToBg: true });
      return;
    }
    if (!restoreInterruptedProgressIfNeeded(video)) {
      enforceStartFromZero(video);
    }
  }

  function onPause(e) {
    if (!isMusicTab || trackEndTriggered) return;
    const video = e.currentTarget;
    if (userManuallyPaused) {
      if (currentTrackKey && video && Number.isFinite(video.currentTime) && video.currentTime > 1) {
        saveProgress(currentTrackKey, video.currentTime, true, { reportToBg: true });
      }
      return;
    }
    // 页面刚加载的前 4.5 秒内，如果B站因为全局“自动开播=关”而把视频暂停，插件自动拉起播放
    if (Date.now() < autoPlayDeadline) {
      setTimeout(() => tryAutoPlay(video), 120);
    }
  }

  function attachToVideo(video) {
    if (!video || trackedVideo === video) return;
    syncTrackAnchor(location.href);
    trackedVideo = video;
    trackEndTriggered = false;
    userManuallySeeked = false;
    autoPlayDeadline = Date.now() + 4500;

    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("pause", onPause);
    video.addEventListener("loadedmetadata", () => {
      if (!restoreInterruptedProgressIfNeeded(video)) {
        enforceStartFromZero(video);
      }
      tryAutoPlay(video);
    });
    video.addEventListener("canplay", () => {
      if (!restoreInterruptedProgressIfNeeded(video)) {
        enforceStartFromZero(video);
      }
      tryAutoPlay(video);
    });

    if (!restoreInterruptedProgressIfNeeded(video)) {
      enforceStartFromZero(video);
    }
    tryAutoPlay(video);
  }

  function renderBadge() {
    if (!isMusicTab) {
      if (badgeEl) {
        badgeEl.remove();
        badgeEl = null;
      }
      return;
    }

    if (!badgeEl) {
      badgeEl = document.createElement("div");
      badgeEl.id = "bili-fav-music-badge";
      badgeEl.style.cssText = [
        "position:fixed",
        "left:16px",
        "bottom:16px",
        "z-index:999999",
        "display:flex",
        "align-items:center",
        "gap:8px",
        "padding:6px 12px",
        "border-radius:999px",
        "background:rgba(24,25,28,0.88)",
        "backdrop-filter:blur(8px)",
        "color:#fff",
        "font-size:12px",
        "font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif",
        "box-shadow:0 4px 14px rgba(0,0,0,0.28)",
        "border:1px solid rgba(251,114,153,0.55)",
        "user-select:none"
      ].join(";");
      document.body.appendChild(badgeEl);
    }

    const modeText = MODE_LABELS[playMode] || MODE_LABELS.shuffle;
    badgeEl.innerHTML = `
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#FB7299;box-shadow:0 0 6px #FB7299;"></span>
      <span style="font-weight:600;color:#FB7299;">听歌专属页</span>
      <span style="color:rgba(255,255,255,0.78);">${modeText}</span>
      <button id="bili-fav-music-next-btn" style="margin-left:4px;padding:2px 8px;border:none;border-radius:999px;background:#FB7299;color:#fff;font-size:11px;font-weight:600;cursor:pointer;">下一首 ⏭</button>
    `;

    const nextBtn = badgeEl.querySelector("#bili-fav-music-next-btn");
    if (nextBtn) {
      nextBtn.onclick = (e) => {
        e.stopPropagation();
        clearSavedProgress();
        chrome.runtime.sendMessage({ type: "NEXT_TRACK" });
      };
    }
  }

  function applyMusicModeState(nextIsMusicTab, nextPlayMode, nextTrack, bgProgress = null) {
    const becameActive = !isMusicTab && nextIsMusicTab;
    isMusicTab = Boolean(nextIsMusicTab);
    if (nextPlayMode) playMode = nextPlayMode;
    if (nextTrack !== undefined) currentTrack = nextTrack;

    // 同步标签页身份标记到 sessionStorage：
    // 这样即使长时间暂停被浏览器休眠丢弃，再次点开标签页刷新时也能立即认领回听歌页身份
    setSessionTabClaim(isMusicTab);

    if (isMusicTab) {
      syncTrackAnchor(location.href, bgProgress);
    }

    renderBadge();

    if (isMusicTab) {
      const v = document.querySelector("video");
      if (v) {
        if (becameActive) {
          userManuallySeeked = false;
          trackEndTriggered = false;
          autoPlayDeadline = Date.now() + 4500;
          // 如果正在播放中，把当前时间立刻记入断点，防止后续切走再切回时被误拉回 00:00
          if (currentTrackKey && Number.isFinite(v.currentTime) && v.currentTime > 1.5) {
            playbackStarted = true;
            historySeekChecked = true;
            saveProgress(currentTrackKey, v.currentTime, v.paused, { reportToBg: true });
          }
        }
        attachToVideo(v);
        tryAutoPlay(v);
      }
    }
  }

  // 定期巡检：仅当本标签页是听歌专属页时，确保绑定 <video> 并在新视频加载时自动开播
  setInterval(() => {
    if (!isMusicTab) return;
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (syncTrackAnchor(location.href)) {
        trackEndTriggered = false;
        userManuallyPaused = false;
        userManuallySeeked = false;
        autoPlayDeadline = Date.now() + 4500;
      }
      chrome.runtime.sendMessage({ type: "GET_STATUS", claimMusicTab: hasSessionTabClaim() }, (res) => {
        if (!chrome.runtime.lastError && res?.ok) {
          applyMusicModeState(res.isMusicTab, res.state?.playMode, res.state?.currentTrack, res.state?.currentProgress);
        }
      });
    }
    const v = document.querySelector("video");
    if (v) {
      if (trackedVideo !== v) {
        attachToVideo(v);
      } else {
        // 如果同一首歌在播放途中被B站重置到了 0 点，立即恢复到刚才记录的进度
        restoreInterruptedProgressIfNeeded(v);
        if (Date.now() < autoPlayDeadline && v.paused && !userManuallyPaused && !trackEndTriggered) {
          tryAutoPlay(v);
        }
      }
    }
  }, 500);

  document.addEventListener("visibilitychange", () => {
    const v = document.querySelector("video");

    if (document.visibilityState === "hidden") {
      if (isMusicTab && v && currentTrackKey && Number.isFinite(v.currentTime) && v.currentTime > 1) {
        saveProgress(currentTrackKey, v.currentTime, v.paused, { reportToBg: true });
      }
      return;
    }

    // —— 切回标签页 ——
    syncTrackAnchor(location.href);

    // 如果本页曾是听歌专属页（sessionStorage 有标记），但因为休眠刚醒来，主动向 background 同步/认领一次
    if (!isMusicTab && hasSessionTabClaim()) {
      chrome.runtime.sendMessage({ type: "GET_STATUS", claimMusicTab: true }, (res) => {
        if (!chrome.runtime.lastError && res?.ok) {
          applyMusicModeState(res.isMusicTab, res.state?.playMode, res.state?.currentTrack, res.state?.currentProgress);
        }
      });
      return;
    }

    if (!isMusicTab) return;

    if (v) {
      // 如果切回来时B站播放器重建或把进度归零了，立刻恢复到持续记录的 activeProgress
      restoreInterruptedProgressIfNeeded(v);

      if (v.paused && !userManuallyPaused && !trackEndTriggered) {
        let retries = 0;
        const wakeUp = () => {
          if (!isMusicTab || !v.paused || userManuallyPaused || trackEndTriggered) return;
          tryAutoPlay(v);
          if (retries++ < 3) setTimeout(wakeUp, 600);
        };
        wakeUp();
      }

      // 延迟再兜底检查一次（应对B站异步重建 <video> 节点的情况）
      setTimeout(() => {
        const cur = document.querySelector("video");
        if (!isMusicTab || !cur || trackEndTriggered || userManuallySeeked) return;
        restoreInterruptedProgressIfNeeded(cur);
        if (cur.paused && !userManuallyPaused) {
          tryAutoPlay(cur);
        }
      }, 900);
    }
  });

  // 页面刚加载时先建立曲目标识
  syncTrackAnchor(location.href);

  // 初始化向 background 查询当前标签页是否为“听歌专属页”（若含 sessionStorage 标记则自动认领）
  chrome.runtime.sendMessage({ type: "GET_STATUS", claimMusicTab: hasSessionTabClaim() }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) return;
    applyMusicModeState(res.isMusicTab, res.state?.playMode, res.state?.currentTrack, res.state?.currentProgress);
  });

  // 监听来自插件面板或 background 的实时指令
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "MUSIC_MODE_UPDATE") {
      applyMusicModeState(msg.isMusicTab, msg.playMode, msg.currentTrack, msg.currentProgress);
      sendResponse({ ok: true });
      return false;
    }

    if (msg?.type === "PLAYER_TOGGLE_PLAY") {
      const v = document.querySelector("video");
      if (!v) {
        sendResponse({ ok: false });
        return false;
      }
      if (v.paused) {
        userManuallyPaused = false;
        v.play().catch(() => {});
        if (currentTrackKey && Number.isFinite(v.currentTime)) {
          saveProgress(currentTrackKey, v.currentTime, false, { reportToBg: true });
        }
        sendResponse({ ok: true, paused: false, currentTime: v.currentTime, duration: v.duration });
      } else {
        userManuallyPaused = true;
        v.pause();
        if (currentTrackKey && Number.isFinite(v.currentTime)) {
          saveProgress(currentTrackKey, v.currentTime, true, { reportToBg: true });
        }
        sendResponse({ ok: true, paused: true, currentTime: v.currentTime, duration: v.duration });
      }
      return false;
    }

    if (msg?.type === "GET_PLAYER_TIME") {
      const v = document.querySelector("video");
      if (!v) {
        sendResponse({ ok: false });
        return false;
      }
      sendResponse({
        ok: true,
        paused: v.paused,
        currentTime: Number.isFinite(v.currentTime) ? v.currentTime : 0,
        duration: Number.isFinite(v.duration) ? v.duration : 0
      });
      return false;
    }

    return false;
  });
})();
