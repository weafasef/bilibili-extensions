// background.js - B站收藏夹纯净听歌 Service Worker

// 不内置任何账号信息：用户 UID 与收藏夹列表都在运行时通过 B 站接口读取当前登录账号
const DEFAULT_STATE = {
  musicTabId: null,
  userMid: null,
  userName: "",
  folders: [],
  currentFolderId: null,
  itemsByFolder: {},
  pagesByBvid: {},
  selectedPagesByBvid: {},
  disabledBvids: {},
  playMode: "shuffle", // 默认随机播放: "shuffle" | "order" | "loop"
  currentTrack: null,
  shuffleOrder: [],
  history: [],
  lastSyncAt: 0
};

async function getState() {
  const stored = await chrome.storage.local.get("musicState");
  const state = Object.assign({}, DEFAULT_STATE, stored.musicState || {});
  if (state.musicTabId !== null) {
    try {
      await chrome.tabs.get(state.musicTabId);
    } catch {
      state.musicTabId = null;
      await chrome.storage.local.set({ musicState: state });
    }
  }
  await updateBadge(state);
  return state;
}

async function saveState(state) {
  await chrome.storage.local.set({ musicState: state });
  await updateBadge(state);
  return state;
}

async function updateBadge(state) {
  try {
    if (state.musicTabId !== null) {
      await chrome.action.setBadgeText({ text: "听" });
      await chrome.action.setBadgeBackgroundColor({ color: "#FB7299" });
    } else {
      await chrome.action.setBadgeText({ text: "" });
    }
  } catch {
    // ignore badge errors
  }
}

// 获取当前可播放的曲目列表（展开用户勾选的分P，默认多P视频只取P1）
function buildPlayableTracks(state, folderId = state.currentFolderId) {
  const items = state.itemsByFolder[folderId] || [];
  const tracks = [];
  for (const item of items) {
    if (!item || !item.bvid) continue;
    if (state.disabledBvids && state.disabledBvids[item.bvid]) continue;
    const pageCount = Number(item.pageCount || 1);
    if (pageCount <= 1) {
      tracks.push({
        key: `${item.bvid}:1`,
        bvid: item.bvid,
        p: 1,
        title: item.title,
        partTitle: "",
        upperName: item.upperName || "",
        duration: item.duration || 0,
        pageCount: 1,
        folderId
      });
    } else {
      const selected = Array.isArray(state.selectedPagesByBvid?.[item.bvid])
        ? state.selectedPagesByBvid[item.bvid]
        : [1]; // 多P视频默认只播 P1，不播其他未勾选分P
      const sortedPages = [...selected].map(Number).filter(n => n >= 1 && n <= pageCount).sort((a, b) => a - b);
      const cachedPages = state.pagesByBvid?.[item.bvid] || [];
      for (const p of sortedPages) {
        const pInfo = cachedPages.find(x => Number(x.page) === p);
        tracks.push({
          key: `${item.bvid}:${p}`,
          bvid: item.bvid,
          p,
          title: item.title,
          partTitle: pInfo?.part || `P${p}`,
          upperName: item.upperName || "",
          duration: pInfo?.duration || item.duration || 0,
          pageCount,
          folderId
        });
      }
    }
  }
  return tracks;
}

function cryptoRandomInt(maxExclusive) {
  if (maxExclusive <= 1) return 0;
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return arr[0] % maxExclusive;
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = cryptoRandomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function buildTrackUrl(track) {
  if (!track || !track.bvid) return "https://www.bilibili.com/";
  const pQuery = track.p && Number(track.p) > 1 ? `?p=${Number(track.p)}` : "";
  return `https://www.bilibili.com/video/${track.bvid}/${pQuery}`;
}

function parseBvidAndPFromUrl(urlStr) {
  if (!urlStr) return null;
  try {
    const u = new URL(urlStr);
    const pParam = Number(u.searchParams.get("p") || 1);
    const mVideo = u.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i);
    if (mVideo) {
      return { bvid: mVideo[1], p: pParam >= 1 ? pParam : 1, isCleanVideoPage: true };
    }
    const bvidParam = u.searchParams.get("bvid");
    if (bvidParam && /^BV[0-9A-Za-z]+$/i.test(bvidParam)) {
      return { bvid: bvidParam, p: pParam >= 1 ? pParam : 1, isCleanVideoPage: false };
    }
  } catch {
    // ignore invalid url
  }
  return null;
}

// 读取当前登录账号的 UID 与收藏夹列表（插件不内置任何账号信息）
async function fetchUserAndFolders(state) {
  if (!state.userMid) {
    try {
      const navRes = await fetch("https://api.bilibili.com/x/web-interface/nav", {
        credentials: "include"
      }).then(r => r.json());
      if (navRes?.code === 0 && navRes?.data?.mid) {
        state.userMid = navRes.data.mid;
        state.userName = navRes.data.uname || "";
      }
    } catch {
      // 未登录或网络异常时保持原状态，面板会提示先登录
    }
  }

  // 没有读到 UID 说明浏览器里还没有登录 B 站，直接返回，避免请求无效接口
  if (!state.userMid) return state;

  try {
    const listUrl = `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${state.userMid}`;
    const folderRes = await fetch(listUrl, { credentials: "include" }).then(r => r.json());
    if (folderRes?.code === 0) {
      const list = folderRes?.data?.list;
      if (Array.isArray(list) && list.length > 0) {
        state.folders = list.map(f => ({
          id: Number(f.id),
          title: f.title,
          media_count: Number(f.media_count || 0)
        }));
        // 如果还没有选定有效收藏夹，默认选中第一个（通常为「默认收藏夹」）
        const hasCurrent = state.folders.some(f => f.id === Number(state.currentFolderId));
        if (!hasCurrent) {
          state.currentFolderId = state.folders[0].id;
        }
      } else {
        state.folders = [];
        state.currentFolderId = null;
      }
    }
  } catch {
    // 网络异常时保留已有收藏夹列表
  }
  return state;
}

// Fetch sub-pages for a multi-part BVID
async function fetchVideoPages(bvid, state) {
  try {
    const res = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, {
      credentials: "include"
    }).then(r => r.json());
    const pages = res?.data?.pages;
    if (Array.isArray(pages) && pages.length > 0) {
      state.pagesByBvid[bvid] = pages.map(p => ({
        page: Number(p.page),
        part: p.part || `P${p.page}`,
        duration: Number(p.duration || 0),
        cid: p.cid
      }));
    }
  } catch {
    // ignore fetch error
  }
  return state.pagesByBvid[bvid] || [];
}

// Sync all videos in a favorite folder
async function syncFolderItems(state, folderId = state.currentFolderId) {
  const targetFolderId = Number(folderId || state.currentFolderId || 0);
  // 没有可用收藏夹（未登录 / 没有收藏夹）时不发请求
  if (!targetFolderId) return state;
  const allMedias = [];
  let pn = 1;
  const ps = 20;
  let hasMore = true;

  while (hasMore && pn <= 50) {
    const url = `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${targetFolderId}&platform=web&pn=${pn}&ps=${ps}`;
    const res = await fetch(url, { credentials: "include" }).then(r => r.json());
    if (res?.code !== 0 || !res?.data) {
      break;
    }
    if (res.data.info?.title) {
      const idx = state.folders.findIndex(f => Number(f.id) === targetFolderId);
      if (idx >= 0) {
        state.folders[idx].title = res.data.info.title;
        state.folders[idx].media_count = Number(res.data.info.media_count || 0);
      } else {
        state.folders.push({
          id: targetFolderId,
          title: res.data.info.title,
          media_count: Number(res.data.info.media_count || 0)
        });
      }
    }
    const medias = res.data.medias || [];
    for (const m of medias) {
      // 过滤已失效视频 (attr !== 0 且标题为已失效视频)
      if (!m || !m.bvid || m.title === "已失效视频") continue;
      const pageCount = Number(m.page || 1);
      allMedias.push({
        bvid: m.bvid,
        title: m.title,
        upperName: m.upper?.name || "",
        duration: Number(m.duration || 0),
        pageCount,
        cover: m.cover || ""
      });
      if (pageCount > 1 && !Array.isArray(state.selectedPagesByBvid[m.bvid])) {
        state.selectedPagesByBvid[m.bvid] = [1];
      }
    }
    hasMore = Boolean(res.data.has_more) && medias.length > 0;
    pn += 1;
  }

  if (allMedias.length > 0) {
    state.itemsByFolder[targetFolderId] = allMedias;
    state.lastSyncAt = Date.now();

    // 预加载多P视频的分P标题（最多前8个未缓存的多P视频，方便用户在面板直接看到每P名字）
    const multiItems = allMedias.filter(m => m.pageCount > 1 && !state.pagesByBvid[m.bvid]).slice(0, 8);
    if (multiItems.length > 0) {
      await Promise.allSettled(multiItems.map(m => fetchVideoPages(m.bvid, state)));
    }
  }
  return state;
}

// 选择下一首曲目
function chooseNextTrack(state, { isAutoEnded = false } = {}) {
  const playable = buildPlayableTracks(state);
  if (playable.length === 0) return null;

  const currentKey = state.currentTrack?.key || null;

  // 如果是自然播放结束且处于“单曲循环”，继续播当前曲目
  if (isAutoEnded && state.playMode === "loop" && currentKey) {
    const found = playable.find(t => t.key === currentKey);
    if (found) return found;
  }

  // 列表循环模式
  if (state.playMode === "order") {
    const idx = playable.findIndex(t => t.key === currentKey);
    const nextIdx = idx >= 0 ? (idx + 1) % playable.length : 0;
    if (currentKey) {
      state.history = [...(state.history || []).slice(-99), currentKey];
    }
    const chosen = playable[nextIdx];
    state.currentTrack = chosen;
    return chosen;
  }

  // 随机播放模式（默认）—— 使用不重复洗牌队列，确保听完一轮前不会老是重复同一首
  const validKeys = new Set(playable.map(t => t.key));
  let queue = (state.shuffleOrder || []).filter(k => validKeys.has(k) && k !== currentKey);

  if (queue.length === 0) {
    queue = shuffleArray(playable.map(t => t.key));
    if (queue.length > 1 && queue[0] === currentKey) {
      const swapIdx = 1 + Math.floor(Math.random() * (queue.length - 1));
      [queue[0], queue[swapIdx]] = [queue[swapIdx], queue[0]];
    }
  }

  const nextKey = queue.shift();
  state.shuffleOrder = queue;
  if (currentKey && currentKey !== nextKey) {
    state.history = [...(state.history || []).slice(-99), currentKey];
  }
  const chosen = playable.find(t => t.key === nextKey) || playable[0];
  state.currentTrack = chosen;
  return chosen;
}

// 选择上一首曲目
function choosePrevTrack(state) {
  const playable = buildPlayableTracks(state);
  if (playable.length === 0) return null;

  const validMap = new Map(playable.map(t => [t.key, t]));
  const history = [...(state.history || [])];
  while (history.length > 0) {
    const prevKey = history.pop();
    if (validMap.has(prevKey) && prevKey !== state.currentTrack?.key) {
      state.history = history;
      const chosen = validMap.get(prevKey);
      state.currentTrack = chosen;
      return chosen;
    }
  }

  // 如果没有历史记录，按列表往回退一首或随机选一首
  const currentKey = state.currentTrack?.key;
  const idx = playable.findIndex(t => t.key === currentKey);
  const prevIdx = idx > 0 ? idx - 1 : playable.length - 1;
  const chosen = playable[prevIdx] || playable[0];
  state.currentTrack = chosen;
  return chosen;
}

async function navigateMusicTabToTrack(state, track) {
  if (!state.musicTabId || !track) return false;
  const targetUrl = buildTrackUrl(track);
  try {
    await chrome.tabs.update(state.musicTabId, { url: targetUrl });
    return true;
  } catch {
    state.musicTabId = null;
    await saveState(state);
    return false;
  }
}

async function notifyTabMusicMode(tabId, isMusicTab, state) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "MUSIC_MODE_UPDATE",
      isMusicTab,
      playMode: state.playMode,
      currentTrack: state.currentTrack
    });
  } catch {
    // Tab might not be on bilibili or content script not ready yet
  }
}

// 当听歌专属标签页被关闭时，自动退出听歌模式，不影响任何其他标签页
chrome.tabs.onRemoved.addListener(async (closedTabId) => {
  const state = await getState();
  if (state.musicTabId === closedTabId) {
    state.musicTabId = null;
    await saveState(state);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const state = await getState();

    switch (msg?.type) {
      case "GET_STATUS": {
        const senderTabId = sender?.tab?.id ?? msg.tabId ?? null;
        const isMusicTab = Boolean(senderTabId && state.musicTabId === senderTabId);
        // 如果当前就是听歌专属标签页，根据其 URL 同步当前曲目记录
        if (isMusicTab && sender?.tab?.url) {
          const parsed = parseBvidAndPFromUrl(sender.tab.url);
          if (parsed) {
            const playable = buildPlayableTracks(state);
            const matched = playable.find(t => t.bvid === parsed.bvid && t.p === parsed.p)
              || playable.find(t => t.bvid === parsed.bvid);
            if (matched && state.currentTrack?.key !== matched.key) {
              state.currentTrack = matched;
              await saveState(state);
            }
          }
        }
        sendResponse({
          ok: true,
          isMusicTab,
          state,
          playableCount: buildPlayableTracks(state).length
        });
        break;
      }

      case "INIT_OR_SYNC": {
        await fetchUserAndFolders(state);
        const folderId = Number(msg.folderId || state.currentFolderId || 0);
        state.currentFolderId = folderId || null;
        if (folderId && (msg.force || !state.itemsByFolder[folderId] || state.itemsByFolder[folderId].length === 0)) {
          await syncFolderItems(state, folderId);
        }
        await saveState(state);
        sendResponse({
          ok: true,
          state,
          needsLogin: !state.userMid,
          noFolder: Boolean(state.userMid) && state.folders.length === 0,
          playableCount: buildPlayableTracks(state).length
        });
        break;
      }

      case "ENABLE_MUSIC_TAB": {
        const targetTabId = Number(msg.tabId);
        if (!targetTabId) {
          sendResponse({ ok: false, error: "无效的标签页 ID" });
          break;
        }
        const prevMusicTabId = state.musicTabId;
        if (prevMusicTabId && prevMusicTabId !== targetTabId) {
          await notifyTabMusicMode(prevMusicTabId, false, state);
        }

        // 确保当前收藏夹已加载歌单（未登录 / 无收藏夹时不做任何跳转）
        if (!state.itemsByFolder[state.currentFolderId] || state.itemsByFolder[state.currentFolderId].length === 0) {
          await fetchUserAndFolders(state);
          await syncFolderItems(state, state.currentFolderId);
        }

        if (!state.currentFolderId) {
          await saveState(state);
          sendResponse({
            ok: false,
            error: state.userMid
              ? "没有读取到收藏夹，请先在B站点开一个收藏夹页面并登录后再试"
              : "请先在浏览器中登录B站，再点击开启听歌模式",
            state
          });
          break;
        }

        state.musicTabId = targetTabId;
        // 默认开启时确保是有效的播放模式（初始为随机播放 shuffle）
        if (!state.playMode) {
          state.playMode = "shuffle";
        }

        let tabInfo = null;
        try {
          tabInfo = await chrome.tabs.get(targetTabId);
        } catch {
          // ignore
        }

        const playable = buildPlayableTracks(state);
        const parsed = parseBvidAndPFromUrl(tabInfo?.url || "");
        const matchedInFolder = parsed
          ? (playable.find(t => t.bvid === parsed.bvid && t.p === parsed.p) || playable.find(t => t.bvid === parsed.bvid))
          : null;

        if (matchedInFolder && parsed.isCleanVideoPage) {
          // 当前标签页已经在播放歌单里的某首纯视频页，直接原地接管并自动开播
          state.currentTrack = matchedInFolder;
          await saveState(state);
          await notifyTabMusicMode(targetTabId, true, state);
        } else {
          // 如果当前在 /list/ml... 连播页、其他B站页或空白页，直接跳到纯粹的单视频页接管播放
          const trackToPlay = matchedInFolder || chooseNextTrack(state) || playable[0];
          state.currentTrack = trackToPlay;
          await saveState(state);
          if (trackToPlay) {
            await navigateMusicTabToTrack(state, trackToPlay);
          }
        }

        sendResponse({
          ok: true,
          state,
          playableCount: playable.length
        });
        break;
      }

      case "DISABLE_MUSIC_TAB": {
        const oldTabId = state.musicTabId;
        state.musicTabId = null;
        await saveState(state);
        if (oldTabId) {
          await notifyTabMusicMode(oldTabId, false, state);
        }
        sendResponse({ ok: true, state });
        break;
      }

      case "SET_PLAY_MODE": {
        if (["shuffle", "order", "loop"].includes(msg.playMode)) {
          state.playMode = msg.playMode;
          if (msg.playMode === "shuffle") {
            state.shuffleOrder = [];
          }
          await saveState(state);
          if (state.musicTabId) {
            await notifyTabMusicMode(state.musicTabId, true, state);
          }
        }
        sendResponse({ ok: true, state });
        break;
      }

      case "SWITCH_FOLDER": {
        const folderId = Number(msg.folderId);
        if (folderId) {
          state.currentFolderId = folderId;
          state.shuffleOrder = [];
          if (!state.itemsByFolder[folderId] || msg.force) {
            await syncFolderItems(state, folderId);
          }
          await saveState(state);
        }
        sendResponse({
          ok: true,
          state,
          playableCount: buildPlayableTracks(state).length
        });
        break;
      }

      case "PLAY_SPECIFIC_TRACK": {
        const { bvid, p = 1, tabId } = msg;
        if (tabId && !state.musicTabId) {
          state.musicTabId = Number(tabId);
        }
        const playable = buildPlayableTracks(state);
        let track = playable.find(t => t.bvid === bvid && Number(t.p) === Number(p))
          || playable.find(t => t.bvid === bvid);
        if (!track) {
          const item = (state.itemsByFolder[state.currentFolderId] || []).find(x => x.bvid === bvid);
          if (item) {
            track = {
              key: `${bvid}:${p}`,
              bvid,
              p: Number(p),
              title: item.title,
              partTitle: item.pageCount > 1 ? `P${p}` : "",
              upperName: item.upperName || "",
              duration: item.duration || 0,
              pageCount: item.pageCount || 1,
              folderId: state.currentFolderId
            };
          }
        }
        if (track) {
          if (state.currentTrack?.key && state.currentTrack.key !== track.key) {
            state.history = [...(state.history || []).slice(-99), state.currentTrack.key];
          }
          state.currentTrack = track;
          await saveState(state);
          if (state.musicTabId) {
            await navigateMusicTabToTrack(state, track);
          }
        }
        sendResponse({ ok: true, state });
        break;
      }

      case "NEXT_TRACK":
      case "TRACK_ENDED": {
        const senderTabId = sender?.tab?.id ?? msg.tabId ?? state.musicTabId;
        if (!state.musicTabId || Number(senderTabId) !== Number(state.musicTabId)) {
          sendResponse({ ok: false, ignored: true });
          break;
        }
        const isAutoEnded = msg.type === "TRACK_ENDED";
        if (isAutoEnded && state.playMode === "loop" && state.currentTrack) {
          sendResponse({ ok: true, action: "REPLAY_CURRENT", track: state.currentTrack, state });
          break;
        }
        const nextTrack = chooseNextTrack(state, { isAutoEnded });
        await saveState(state);
        if (nextTrack) {
          await navigateMusicTabToTrack(state, nextTrack);
        }
        sendResponse({ ok: true, action: "NAVIGATED", track: nextTrack, state });
        break;
      }

      case "PREV_TRACK": {
        if (!state.musicTabId) {
          sendResponse({ ok: false });
          break;
        }
        const prevTrack = choosePrevTrack(state);
        await saveState(state);
        if (prevTrack) {
          await navigateMusicTabToTrack(state, prevTrack);
        }
        sendResponse({ ok: true, track: prevTrack, state });
        break;
      }

      case "FETCH_VIDEO_PAGES": {
        const bvid = msg.bvid;
        if (bvid) {
          await fetchVideoPages(bvid, state);
          await saveState(state);
        }
        sendResponse({
          ok: true,
          pages: state.pagesByBvid[bvid] || [],
          selectedPages: state.selectedPagesByBvid[bvid] || [1],
          state
        });
        break;
      }

      case "UPDATE_SELECTED_PAGES": {
        const { bvid, pages } = msg;
        if (bvid && Array.isArray(pages)) {
          state.selectedPagesByBvid[bvid] = pages.map(Number).filter(n => n >= 1).sort((a, b) => a - b);
          state.shuffleOrder = [];
          await saveState(state);
        }
        sendResponse({
          ok: true,
          state,
          playableCount: buildPlayableTracks(state).length
        });
        break;
      }

      case "TOGGLE_DISABLE_BVID": {
        const { bvid } = msg;
        if (bvid) {
          if (state.disabledBvids[bvid]) {
            delete state.disabledBvids[bvid];
          } else {
            state.disabledBvids[bvid] = true;
          }
          state.shuffleOrder = [];
          await saveState(state);
        }
        sendResponse({
          ok: true,
          state,
          playableCount: buildPlayableTracks(state).length
        });
        break;
      }

      case "FOCUS_MUSIC_TAB": {
        if (state.musicTabId) {
          try {
            const tab = await chrome.tabs.get(state.musicTabId);
            await chrome.tabs.update(state.musicTabId, { active: true });
            if (tab.windowId) {
              await chrome.windows.update(tab.windowId, { focused: true });
            }
          } catch {
            state.musicTabId = null;
            await saveState(state);
          }
        }
        sendResponse({ ok: true, state });
        break;
      }

      default:
        sendResponse({ ok: false, error: "Unknown message type" });
    }
  })();
  return true;
});
