// content.js - 仅在被设为“听歌专属标签页”的那 1 个标签页内生效，绝不修改 B 站全局设置或其他标签页

(() => {
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

  const MODE_LABELS = {
    shuffle: "🔀 随机播放",
    order: "🔁 列表循环",
    loop: "🔂 单曲循环"
  };

  function markManualInteraction(e) {
    if (!isMusicTab || !trackedVideo) return;
    // 用户在播放器区域点击或按空格/K键暂停时，尊重用户的手动暂停；点击进度条或按方向键时，尊重用户的手动拖进度
    if (e.type === "keydown") {
      if (e.code === "Space" || e.key === "k" || e.key === "K") {
        userManuallyPaused = !trackedVideo.paused;
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
        }
      }
    }
  }

  window.addEventListener("keydown", markManualInteraction, true);
  window.addEventListener("pointerdown", markManualInteraction, true);

  // 如果在刚加载阶段B站自动恢复了上次的历史播放进度，强制拉回 00:00 从头播放
  function enforceStartFromZero(video) {
    if (!isMusicTab || !video || userManuallySeeked) return false;
    const elapsedSinceLoadSec = (Date.now() - trackLoadWallTime) / 1000;
    // 加载后的前 6 秒内，正常从0播放绝不可能超过 elapsed + 2 秒；一旦超出说明是B站恢复了历史观看进度
    if (elapsedSinceLoadSec < 6 && video.currentTime > Math.max(2.5, elapsedSinceLoadSec + 1.8)) {
      try {
        video.currentTime = 0;
      } catch {
        // ignore
      }
      return true;
    }
    return false;
  }

  function tryAutoPlay(video) {
    if (!isMusicTab || !video || trackEndTriggered || userManuallyPaused) return;
    enforceStartFromZero(video);
    if (video.paused) {
      video.play().catch(() => {
        // 如果浏览器策略短暂拦截，稍后重试
      });
    }
  }

  function handleTrackFinished(video) {
    if (!isMusicTab || trackEndTriggered) return;
    // 防止B站历史记录刚好停在片尾最后一秒、刚打开页面就误判为播放结束
    if (enforceStartFromZero(video)) {
      tryAutoPlay(video);
      return;
    }
    trackEndTriggered = true;

    if (playMode === "loop") {
      // 单曲循环：直接回到开头重播，不触发B站切集
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
    if (!isMusicTab || trackEndTriggered) return;
    const video = e.currentTarget;
    if (!video) return;
    if (enforceStartFromZero(video)) return;
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
    if (video) {
      enforceStartFromZero(video);
    }
  }

  function onPause(e) {
    if (!isMusicTab || trackEndTriggered || userManuallyPaused) return;
    const video = e.currentTarget;
    // 页面刚加载的前 4.5 秒内，如果B站因为全局“自动开播=关”而把视频暂停，插件自动拉起播放
    if (Date.now() < autoPlayDeadline) {
      setTimeout(() => tryAutoPlay(video), 120);
    }
  }

  function attachToVideo(video) {
    if (!video || trackedVideo === video) return;
    trackedVideo = video;
    trackEndTriggered = false;
    userManuallyPaused = false;
    userManuallySeeked = false;
    trackLoadWallTime = Date.now();
    autoPlayDeadline = Date.now() + 4500;

    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("pause", onPause);
    video.addEventListener("loadedmetadata", () => {
      enforceStartFromZero(video);
      tryAutoPlay(video);
    });
    video.addEventListener("canplay", () => {
      enforceStartFromZero(video);
      tryAutoPlay(video);
    });

    enforceStartFromZero(video);
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
        chrome.runtime.sendMessage({ type: "NEXT_TRACK" });
      };
    }
  }

  function applyMusicModeState(nextIsMusicTab, nextPlayMode, nextTrack) {
    const becameActive = !isMusicTab && nextIsMusicTab;
    isMusicTab = Boolean(nextIsMusicTab);
    if (nextPlayMode) playMode = nextPlayMode;
    if (nextTrack !== undefined) currentTrack = nextTrack;

    renderBadge();

    if (isMusicTab) {
      const v = document.querySelector("video");
      if (v) {
        if (becameActive) {
          userManuallyPaused = false;
          userManuallySeeked = false;
          trackEndTriggered = false;
          trackLoadWallTime = Date.now();
          autoPlayDeadline = Date.now() + 4500;
          try {
            v.currentTime = 0;
          } catch {
            // ignore
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
      trackEndTriggered = false;
      userManuallyPaused = false;
      userManuallySeeked = false;
      trackLoadWallTime = Date.now();
      autoPlayDeadline = Date.now() + 4500;
      chrome.runtime.sendMessage({ type: "GET_STATUS" }, (res) => {
        if (!chrome.runtime.lastError && res?.ok) {
          applyMusicModeState(res.isMusicTab, res.state?.playMode, res.state?.currentTrack);
        }
      });
    }
    const v = document.querySelector("video");
    if (v) {
      if (trackedVideo !== v) {
        attachToVideo(v);
      } else if (Date.now() < autoPlayDeadline && v.paused && !userManuallyPaused && !trackEndTriggered) {
        tryAutoPlay(v);
      }
    }
  }, 500);

  // 初始化向 background 查询当前标签页是否为“听歌专属页”
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (res) => {
    if (chrome.runtime.lastError || !res?.ok) return;
    applyMusicModeState(res.isMusicTab, res.state?.playMode, res.state?.currentTrack);
  });

  // 监听来自插件面板或 background 的实时指令
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "MUSIC_MODE_UPDATE") {
      applyMusicModeState(msg.isMusicTab, msg.playMode, msg.currentTrack);
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
        sendResponse({ ok: true, paused: false, currentTime: v.currentTime, duration: v.duration });
      } else {
        userManuallyPaused = true;
        v.pause();
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
