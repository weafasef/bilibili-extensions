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

  function renderHeaderCard() {
    if (!currentState) return;
    const musicTabId = currentState.musicTabId;
    const curTabId = activeBrowserTab?.id || null;

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
      statusDesc.textContent = "当前标签页是普通标签页（不受影响）。你可以跳去听歌页，或改用当前页听歌。";

      const focusBtn = document.createElement("button");
      focusBtn.className = "btn btn-ghost";
      focusBtn.textContent = "定位过去";
      focusBtn.onclick = async () => {
        await sendMsg({ type: "FOCUS_MUSIC_TAB" });
        window.close();
      };

      const switchHereBtn = document.createElement("button");
      switchHereBtn.className = "btn btn-primary";
      switchHereBtn.textContent = "改用当前页";
      switchHereBtn.onclick = async () => {
        if (!curTabId) return;
        const res = await sendMsg({ type: "ENABLE_MUSIC_TAB", tabId: curTabId });
        if (res.ok) {
          currentState = res.state;
          playableCount = res.playableCount ?? playableCount;
          renderAll();
        }
      };

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

      tabModeActions.append(focusBtn, switchHereBtn, offBtn);
    } else {
      // 尚未开启听歌专属页
      tabModeCard.classList.remove("is-active");
      statusDot.className = "brand-dot";
      statusTitle.textContent = "当前标签页未开启听歌模式";
      statusDesc.textContent = "点右侧按钮把当前标签页变成听歌专属页（自动开播 + 默认随机切歌，不改其他页设置）。";

      const enableBtn = document.createElement("button");
      enableBtn.className = "btn btn-primary";
      enableBtn.textContent = "🎵 设为听歌专属页";
      enableBtn.onclick = async () => {
        if (!curTabId) return;
        enableBtn.disabled = true;
        enableBtn.textContent = "正在开启...";
        const res = await sendMsg({ type: "ENABLE_MUSIC_TAB", tabId: curTabId });
        if (res.ok) {
          currentState = res.state;
          playableCount = res.playableCount ?? playableCount;
          renderAll();
        } else {
          enableBtn.disabled = false;
          enableBtn.textContent = "🎵 设为听歌专属页";
          statusDesc.textContent = res.error || "开启失败，请先在浏览器登录B站后重试。";
          statusDesc.style.color = "#d33";
          setTimeout(() => {
            statusDesc.style.color = "";
          }, 4000);
        }
      };
      tabModeActions.appendChild(enableBtn);
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
      main.title = "点击立即在听歌专属页播放这首";
      main.onclick = async () => {
        const defaultP = pageCount > 1 ? (selectedPages[0] || 1) : 1;
        const res = await sendMsg({
          type: "PLAY_SPECIFIC_TRACK",
          bvid: item.bvid,
          p: defaultP,
          tabId: activeBrowserTab?.id
        });
        if (res.ok) {
          currentState = res.state;
          renderAll();
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
              p: pNum,
              tabId: activeBrowserTab?.id
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
    const res = await sendMsg({ type: "PREV_TRACK" });
    if (res.ok) {
      currentState = res.state;
      renderAll();
    }
  };

  nextBtn.onclick = async () => {
    if (!currentState?.musicTabId && activeBrowserTab?.id) {
      const res = await sendMsg({ type: "ENABLE_MUSIC_TAB", tabId: activeBrowserTab.id });
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
    if (!currentState?.musicTabId && activeBrowserTab?.id) {
      const res = await sendMsg({ type: "ENABLE_MUSIC_TAB", tabId: activeBrowserTab.id });
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
