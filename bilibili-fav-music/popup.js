// popup.js - B站收藏夹纯净听歌面板逻辑

(() => {
  let activeBrowserTab = null;
  let currentState = null;
  let playableCount = 0;
  let searchKeyword = "";
  const expandedMultiPBvids = new Set();

  const tabModeCard = document.getElementById("tabModeCard");
  const statusDot = document.getElementById("statusDot");
  const statusTitle = document.getElementById("statusTitle");
  const statusDesc = document.getElementById("statusDesc");
  const tabModeActions = document.getElementById("tabModeActions");

  const nowTitle = document.getElementById("nowTitle");
  const nowUpper = document.getElementById("nowUpper");
  const nowTime = document.getElementById("nowTime");

  const modeBtns = Array.from(document.querySelectorAll(".mode-btn"));
  const prevBtn = document.getElementById("prevBtn");
  const playPauseBtn = document.getElementById("playPauseBtn");
  const nextBtn = document.getElementById("nextBtn");

  const folderSelect = document.getElementById("folderSelect");
  const syncBtn = document.getElementById("syncBtn");
  const searchInput = document.getElementById("searchInput");
  const trackCounter = document.getElementById("trackCounter");

  const emptyState = document.getElementById("emptyState");
  const playlistEl = document.getElementById("playlist");

  function formatDuration(sec) {
    const s = Math.max(0, Math.floor(Number(sec || 0)));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }

  function sendMsg(payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(payload, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(res || { ok: false });
      });
    });
  }

  function sendTabMsg(tabId, payload) {
    return new Promise((resolve) => {
      if (!tabId) {
        resolve({ ok: false });
        return;
      }
      chrome.tabs.sendMessage(tabId, payload, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false });
          return;
        }
        resolve(res || { ok: false });
      });
    });
  }

  function isBilibiliVideoTab(tab) {
    try {
      const u = new URL(tab?.url || "");
      return /(^|\.)bilibili\.com$/i.test(u.hostname) && (/\/video\/BV[0-9A-Za-z]+/i.test(u.pathname) || /^\/list\//.test(u.pathname));
    } catch {
      return false;
    }
  }

  async function runEnableMusic(actionBtn, payload) {
    actionBtn.disabled = true;
    actionBtn.textContent = "正在开启...";
    const res = await sendMsg({ type: "ENABLE_MUSIC_TAB", ...payload });
    if (res.ok) {
      currentState = res.state;
      playableCount = res.playableCount ?? playableCount;
      renderAll();
      return true;
    }
    actionBtn.disabled = false;
    actionBtn.textContent = payload.label || "🎵 开始听歌";
    statusDesc.textContent = res.error || "开启失败，请先在浏览器登录B站后重试。";
    statusDesc.style.color = "#d33";
    setTimeout(() => {
      statusDesc.style.color = "";
    }, 5000);
    return false;
  }

  function renderHeaderCard() {
    if (!currentState) return;
    const musicTabId = currentState.musicTabId;
    const curTabId = activeBrowserTab?.id || null;
    const onVideoPage = isBilibiliVideoTab(activeBrowserTab);

    tabModeActions.innerHTML = "";

    if (musicTabId && curTabId && Number(musicTabId) === Number(curTabId)) {
      // 当前标签页就是听歌专属页
      tabModeCard.classList.add("is-active");
      statusDot.className = "brand-dot active";
      statusTitle.textContent = "当前标签页：听歌专属页运行中";
      statusDesc.textContent = "本页已接管自动开播与随机切歌；你打开的其他B站标签页完全保持原样。";

      const disableBtn = document.createElement("button");
      disableBtn.className = "btn btn-outline";
      disableBtn.textContent = "关闭听歌模式";
      disableBtn.onclick = async () => {
        const res = await sendMsg({ type: "DISABLE_MUSIC_TAB" });
        if (res.ok) {
          currentState = res.state;
          renderAll();
        }
      };
      tabModeActions.appendChild(disableBtn);
    } else if (musicTabId) {
      // 另一个标签页是听歌专属页
      tabModeCard.classList.add("is-active");
      statusDot.className = "brand-dot other";
      statusTitle.textContent = "另一个标签页正在听歌";
      statusDesc.textContent = onVideoPage
        ? "当前标签页是普通B站视频页（不受影响）。可以跳去听歌页，或改用当前页听歌。"
        : "当前页面不受影响。点「定位过去」可以跳到正在听歌的那个标签页。";

      const focusBtn = document.createElement("button");
      focusBtn.className = "btn btn-ghost";
      focusBtn.textContent = "定位过去";
      focusBtn.onclick = async () => {
        await sendMsg({ type: "FOCUS_MUSIC_TAB" });
        window.close();
      };

      const otherBtn = document.createElement("button");
      otherBtn.className = "btn btn-primary";
      otherBtn.textContent = "改用当前页";
      otherBtn.onclick = () => runEnableMusic(otherBtn, { tabId: curTabId, adoptCurrent: true, label: "改用当前页" });

      const offBtn = document.createElement("button");
      offBtn.className = "btn btn-outline";
      offBtn.textContent = "关闭";
      offBtn.onclick = async () => {
        const res = await sendMsg({ type: "DISABLE_MUSIC_TAB" });
        if (res.ok) {
          currentState = res.state;
          renderAll();
        }
      };

      if (onVideoPage) {
        tabModeActions.append(focusBtn, otherBtn, offBtn);
      } else {
        tabModeActions.append(focusBtn, offBtn);
      }
    } else {
      // 尚未开启听歌模式
      tabModeCard.classList.remove("is-active");
      statusDot.className = "brand-dot";

      if (onVideoPage) {
        statusTitle.textContent = "当前标签页未开启听歌模式";
        statusDesc.textContent = "开启后本页自动开播、随机切歌。也可以新开一个标签页听，当前页保持原样。";

        const enableBtn = document.createElement("button");
        enableBtn.className = "btn btn-primary";
        enableBtn.textContent = "🎵 设为听歌专属页";
        enableBtn.onclick = () => {
          if (!curTabId) return;
          runEnableMusic(enableBtn, { tabId: curTabId, adoptCurrent: true, label: "🎵 设为听歌专属页" });
        };

        const newTabBtn = document.createElement("button");
        newTabBtn.className = "btn btn-ghost";
        newTabBtn.textContent = "新开一页";
        newTabBtn.title = "不占用当前视频页，另开一个标签页听歌";
        newTabBtn.onclick = () => {
          if (!curTabId) return;
          runEnableMusic(newTabBtn, { tabId: curTabId, forceNewTab: true, label: "新开一页" });
        };

        tabModeActions.append(enableBtn, newTabBtn);
      } else {
        statusTitle.textContent = "当前页面不是B站视频页";
        statusDesc.textContent = "点右侧按钮会新开一个标签页开始播放歌单，当前页面（网课、文档等）不会被覆盖。";

        const newTabBtn = document.createElement("button");
        newTabBtn.className = "btn btn-primary";
        newTabBtn.textContent = "🎵 新开标签页听歌";
        newTabBtn.onclick = () => {
          if (!curTabId) return;
          runEnableMusic(newTabBtn, { tabId: curTabId, forceNewTab: true, label: "🎵 新开标签页听歌" });
        };
        tabModeActions.appendChild(newTabBtn);
      }
    }
  }

  function renderNowPlaying() {
    if (!currentState) return;
    const track = currentState.currentTrack;
    if (track) {
      const partSuffix = track.pageCount > 1 ? ` [P${track.p}${track.partTitle ? " · " + track.partTitle : ""}]` : "";
      nowTitle.textContent = `${track.title}${partSuffix}`;
      nowTitle.title = `${track.title}${partSuffix}`;
      nowUpper.textContent = track.upperName ? `UP: ${track.upperName}` : track.bvid;
    } else {
      nowTitle.textContent = "尚未开始播放";
      nowUpper.textContent = "点下方任意歌曲或上方「设为听歌专属页」即可开始";
      nowTime.textContent = "";
    }

    const mode = currentState.playMode || "shuffle";
    for (const btn of modeBtns) {
      btn.classList.toggle("active", btn.dataset.mode === mode);
    }
  }

  function renderFolders() {
    if (!currentState) return;
    const folders = currentState.folders || [];
    const currentId = Number(currentState.currentFolderId);
    folderSelect.innerHTML = "";
    for (const f of folders) {
      const opt = document.createElement("option");
      opt.value = String(f.id);
      opt.textContent = `${f.title} (${f.media_count ?? 0})`;
      if (Number(f.id) === currentId) {
        opt.selected = true;
      }
      folderSelect.appendChild(opt);
    }
    trackCounter.textContent = `${playableCount} 首可播`;
  }

  function renderPlaylist() {
    if (!currentState) return;
    const folderId = currentState.currentFolderId;
    const items = currentState.itemsByFolder?.[folderId] || [];

    const kw = searchKeyword.trim().toLowerCase();
    const filtered = kw
      ? items.filter(
          (x) =>
            (x.title || "").toLowerCase().includes(kw) ||
            (x.upperName || "").toLowerCase().includes(kw) ||
            (x.bvid || "").toLowerCase().includes(kw)
        )
      : items;

    playlistEl.innerHTML = "";

    if (items.length === 0) {
      emptyState.style.display = "block";
      const folders = currentState.folders || [];
      if (folders.length === 0) {
        emptyState.textContent = "未读取到收藏夹：请先在本浏览器登录 bilibili.com，然后点上方「🔄 同步」";
      } else {
        emptyState.textContent = "当前收藏夹暂无歌曲，点击上方「🔄 同步」拉取歌单";
      }
      return;
    }

    if (filtered.length === 0) {
      emptyState.style.display = "block";
      emptyState.textContent = "没有匹配的歌曲";
      return;
    }

    emptyState.style.display = "none";

    filtered.forEach((item, i) => {
      const isDisabled = Boolean(currentState.disabledBvids?.[item.bvid]);
      const isPlaying = Boolean(currentState.currentTrack?.bvid === item.bvid);
      const pageCount = Number(item.pageCount || 1);
      const selectedPages = Array.isArray(currentState.selectedPagesByBvid?.[item.bvid])
        ? currentState.selectedPagesByBvid[item.bvid]
        : [1];

      const row = document.createElement("div");
      row.className = "song-item" + (isPlaying ? " playing" : "") + (isDisabled ? " disabled" : "");

      const main = document.createElement("div");
      main.className = "song-main";
      main.title = currentState.musicTabId
        ? "点击立即在听歌专属页播放这首"
        : "点击会在新标签页里播放这首，当前页面保持不变";
      main.onclick = async () => {
        const defaultP = pageCount > 1 ? (selectedPages[0] || 1) : 1;
        const res = await sendMsg({
          type: "PLAY_SPECIFIC_TRACK",
          bvid: item.bvid,
          p: defaultP
        });
        if (res.ok) {
          currentState = res.state;
          renderAll();
        } else if (res.error) {
          statusDesc.textContent = res.error;
          statusDesc.style.color = "#d33";
          setTimeout(() => {
            statusDesc.style.color = "";
          }, 5000);
        }
      };

      const idxEl = document.createElement("div");
      idxEl.className = "song-idx";
      idxEl.textContent = isPlaying ? "♪" : String(i + 1);

      const infoEl = document.createElement("div");
      infoEl.className = "song-info";

      const titleEl = document.createElement("div");
      titleEl.className = "song-title";
      titleEl.textContent = item.title;

      const subEl = document.createElement("div");
      subEl.className = "song-sub";
      subEl.innerHTML = `
        <span class="song-upper">${item.upperName || item.bvid}</span>
        <span>·</span>
        <span>${formatDuration(item.duration)}</span>
      `;

      infoEl.append(titleEl, subEl);

      const actionsEl = document.createElement("div");
      actionsEl.className = "song-actions";

      if (pageCount > 1) {
        const mpBtn = document.createElement("button");
        mpBtn.className = "multip-badge";
        mpBtn.textContent = `分P (${selectedPages.length}/${pageCount}P) ▾`;
        mpBtn.title = "点击选择这个视频里要听哪几段，未勾选的分段会自动跳过";
        mpBtn.onclick = async (e) => {
          e.stopPropagation();
          if (expandedMultiPBvids.has(item.bvid)) {
            expandedMultiPBvids.delete(item.bvid);
            renderPlaylist();
          } else {
            expandedMultiPBvids.add(item.bvid);
            if (!currentState.pagesByBvid?.[item.bvid]) {
              mpBtn.textContent = "加载分P...";
              const res = await sendMsg({ type: "FETCH_VIDEO_PAGES", bvid: item.bvid });
              if (res.ok) {
                currentState = res.state;
              }
            }
            renderPlaylist();
          }
        };
        actionsEl.appendChild(mpBtn);
      }

      const skipBtn = document.createElement("button");
      skipBtn.className = "skip-toggle";
      skipBtn.textContent = isDisabled ? "恢复" : "跳过";
      skipBtn.title = isDisabled ? "恢复加入随机歌单" : "在歌单里暂时屏蔽这首（不删B站收藏）";
      skipBtn.onclick = async (e) => {
        e.stopPropagation();
        const res = await sendMsg({ type: "TOGGLE_DISABLE_BVID", bvid: item.bvid });
        if (res.ok) {
          currentState = res.state;
          playableCount = res.playableCount ?? playableCount;
          renderAll();
        }
      };
      actionsEl.appendChild(skipBtn);

      main.append(idxEl, infoEl, actionsEl);
      row.appendChild(main);

      // 如果展开了多P选择器
      if (pageCount > 1 && expandedMultiPBvids.has(item.bvid)) {
        const drawer = document.createElement("div");
        drawer.className = "parts-drawer";

        const header = document.createElement("div");
        header.className = "parts-drawer-header";
        header.innerHTML = `<span>勾选要加入歌单的分段（未勾选绝不播放）：</span>`;

        const quickBtns = document.createElement("div");
        quickBtns.className = "parts-quick-btns";

        const onlyP1Btn = document.createElement("button");
        onlyP1Btn.className = "parts-link-btn";
        onlyP1Btn.textContent = "只选P1";
        onlyP1Btn.onclick = async (e) => {
          e.stopPropagation();
          const res = await sendMsg({ type: "UPDATE_SELECTED_PAGES", bvid: item.bvid, pages: [1] });
          if (res.ok) {
            currentState = res.state;
            playableCount = res.playableCount;
            renderAll();
          }
        };

        const allPBtn = document.createElement("button");
        allPBtn.className = "parts-link-btn";
        allPBtn.textContent = "全选";
        allPBtn.onclick = async (e) => {
          e.stopPropagation();
          const allPages = Array.from({ length: pageCount }, (_, k) => k + 1);
          const res = await sendMsg({ type: "UPDATE_SELECTED_PAGES", bvid: item.bvid, pages: allPages });
          if (res.ok) {
            currentState = res.state;
            playableCount = res.playableCount;
            renderAll();
          }
        };

        quickBtns.append(onlyP1Btn, allPBtn);
        header.appendChild(quickBtns);
        drawer.appendChild(header);

        const pagesList = currentState.pagesByBvid?.[item.bvid] ||
          Array.from({ length: pageCount }, (_, k) => ({ page: k + 1, part: `第 ${k + 1} 段`, duration: 0 }));

        for (const pObj of pagesList) {
          const pNum = Number(pObj.page);
          const checked = selectedPages.includes(pNum);

          const pRow = document.createElement("div");
          pRow.className = "part-row";

          const label = document.createElement("label");
          label.className = "part-label";

          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = checked;
          cb.onchange = async () => {
            const nextSet = new Set(selectedPages.map(Number));
            if (cb.checked) {
              nextSet.add(pNum);
            } else {
              nextSet.delete(pNum);
            }
            const res = await sendMsg({
              type: "UPDATE_SELECTED_PAGES",
              bvid: item.bvid,
              pages: Array.from(nextSet)
            });
            if (res.ok) {
              currentState = res.state;
              playableCount = res.playableCount;
              renderAll();
            }
          };

          const nameSpan = document.createElement("span");
          nameSpan.className = "part-name";
          nameSpan.textContent = `P${pNum} · ${pObj.part || ""}${pObj.duration ? " (" + formatDuration(pObj.duration) + ")" : ""}`;
          nameSpan.title = nameSpan.textContent;

          label.append(cb, nameSpan);

          const playPartBtn = document.createElement("button");
          playPartBtn.className = "part-play-btn";
          playPartBtn.textContent = "▶ 播这段";
          playPartBtn.onclick = async (e) => {
            e.stopPropagation();
            const res = await sendMsg({
              type: "PLAY_SPECIFIC_TRACK",
              bvid: item.bvid,
              p: pNum
            });
            if (res.ok) {
              currentState = res.state;
              renderAll();
            }
          };

          pRow.append(label, playPartBtn);
          drawer.appendChild(pRow);
        }

        row.appendChild(drawer);
      }

      playlistEl.appendChild(row);
    });
  }

  function renderAll() {
    renderHeaderCard();
    renderNowPlaying();
    renderFolders();
    renderPlaylist();
  }

  // 事件绑定：切换随机/顺序/单曲循环
  for (const btn of modeBtns) {
    btn.onclick = async () => {
      const mode = btn.dataset.mode;
      const res = await sendMsg({ type: "SET_PLAY_MODE", playMode: mode });
      if (res.ok) {
        currentState = res.state;
        renderNowPlaying();
      }
    };
  }

  prevBtn.onclick = async () => {
    if (!currentState?.musicTabId) {
      const res = await sendMsg({ type: "ENABLE_MUSIC_TAB", tabId: activeBrowserTab?.id });
      if (res.ok) {
        currentState = res.state;
        playableCount = res.playableCount ?? playableCount;
        renderAll();
      }
      return;
    }
    const res = await sendMsg({ type: "PREV_TRACK" });
    if (res.ok) {
      currentState = res.state;
      renderAll();
    }
  };

  nextBtn.onclick = async () => {
    if (!currentState?.musicTabId) {
      const res = await sendMsg({ type: "ENABLE_MUSIC_TAB", tabId: activeBrowserTab?.id });
      if (res.ok) {
        currentState = res.state;
        playableCount = res.playableCount ?? playableCount;
        renderAll();
      }
      return;
    }
    const res = await sendMsg({ type: "NEXT_TRACK", tabId: currentState.musicTabId });
    if (res.ok) {
      currentState = res.state;
      renderAll();
    }
  };

  playPauseBtn.onclick = async () => {
    if (!currentState?.musicTabId) {
      const res = await sendMsg({ type: "ENABLE_MUSIC_TAB", tabId: activeBrowserTab?.id });
      if (res.ok) {
        currentState = res.state;
        playableCount = res.playableCount ?? playableCount;
        renderAll();
      }
      return;
    }
    const r = await sendTabMsg(currentState.musicTabId, { type: "PLAYER_TOGGLE_PLAY" });
    if (r?.ok) {
      playPauseBtn.textContent = r.paused ? "▶" : "⏸";
    }
  };

  folderSelect.onchange = async () => {
    const folderId = Number(folderSelect.value);
    emptyState.style.display = "block";
    emptyState.textContent = "正在加载收藏夹歌单...";
    playlistEl.innerHTML = "";
    const res = await sendMsg({ type: "SWITCH_FOLDER", folderId });
    if (res.ok) {
      currentState = res.state;
      playableCount = res.playableCount;
      renderAll();
    }
  };

  syncBtn.onclick = async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = "同步中...";
    const res = await sendMsg({
      type: "INIT_OR_SYNC",
      folderId: Number(folderSelect.value || currentState?.currentFolderId),
      force: true
    });
    syncBtn.disabled = false;
    syncBtn.textContent = "🔄 同步";
    if (res.ok) {
      currentState = res.state;
      playableCount = res.playableCount;
      renderAll();
    }
  };

  searchInput.oninput = () => {
    searchKeyword = searchInput.value || "";
    renderPlaylist();
  };

  // 实时刷新听歌专属页的播放进度与暂停按钮状态
  setInterval(async () => {
    if (!currentState?.musicTabId) {
      nowTime.textContent = "";
      playPauseBtn.textContent = "⏯";
      return;
    }
    const r = await sendTabMsg(currentState.musicTabId, { type: "GET_PLAYER_TIME" });
    if (r?.ok && r.duration > 0) {
      nowTime.textContent = `${formatDuration(r.currentTime)} / ${formatDuration(r.duration)}`;
      playPauseBtn.textContent = r.paused ? "▶" : "⏸";
    }
  }, 1000);

  // 启动初始化
  (async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeBrowserTab = tabs?.[0] || null;

    const statusRes = await sendMsg({ type: "GET_STATUS", tabId: activeBrowserTab?.id });
    if (statusRes?.ok) {
      currentState = statusRes.state;
      playableCount = statusRes.playableCount || 0;
      renderAll();
    }

    const syncRes = await sendMsg({ type: "INIT_OR_SYNC", force: false });
    if (syncRes?.ok) {
      currentState = syncRes.state;
      playableCount = syncRes.playableCount || 0;
      renderAll();
    }
  })();
})();
