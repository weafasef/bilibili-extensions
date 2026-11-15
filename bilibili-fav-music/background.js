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

// 判断某个 URL 是否是可以“原地接管”的 B 站视频页
function isBilibiliVideoUrl(url) {
  try {
    const u = new URL(url || "");
    if (!/(^|\.)bilibili\.com$/i.test(u.hostname)) return false;
    return /\/video\/BV[0-9A-Za-z]+/i.test(u.pathname) || /^\/list\//.test(u.pathname);
  } catch {
    return false;
  }
}

async function getTabSafely(tabId) {
  if (!tabId) return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function activateTab(tab) {
  if (!tab) return;
  try {
    await chrome.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {
    // ignore
  }
}

// 在新标签页里开始听歌：当前正在看的页面（比如网课、文档）完全不受影响
async function openMusicTabWithTrack(state, track, { active = true } = {}) {
  const url = track ? buildTrackUrl(track) : "https://www.bilibili.com/";
  let created = null;
  try {
    created = await chrome.tabs.create({ url, active });
  } catch {
    return null;
  }
  if (!created) return null;
  state.musicTabId = created.id;
  if (track) state.currentTrack = track;
  await saveState(state);
  return created;
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

// 新开的听歌标签页加载完成后再补发一次激活指令，避免“插件状态还没写入存储、页面已经加载完”的竞态
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab?.url || !isBilibiliVideoUrl(tab.url)) return;
  const state = await getState();
  if (state.musicTabId === tabId) {
    await notifyTabMusicMode(tabId, true, state);
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
        const targetTabId = Number(msg.tabId) || null;
        const forceNewTab = Boolean(msg.forceNewTab);
        const adoptCurrent = Boolean(msg.adoptCurrent);

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
              : "请先在浏览器中登录B站，再点击开始听歌",
            state
          });
          break;
        }

        // 默认开启时确保是有效的播放模式（初始为随机播放 shuffle）
        if (!state.playMode) {
          state.playMode = "shuffle";
        }

        const playable = buildPlayableTracks(state);
        const targetTab = await getTabSafely(targetTabId);
        const existingMusicTab = await getTabSafely(state.musicTabId);
        const canAdoptCurrent = !forceNewTab && Boolean(targetTab) && isBilibiliVideoUrl(targetTab?.url);

        // 情况 1：原地接管用户当前这个 B 站视频页（只会发生在用户明确点「设为听歌专属页 / 改用当前页」时）
        if (canAdoptCurrent && (adoptCurrent || !existingMusicTab)) {
          if (existingMusicTab && existingMusicTab.id !== targetTab.id) {
            await notifyTabMusicMode(existingMusicTab.id, false, state);
          }
          state.musicTabId = targetTab.id;

          const parsed = parseBvidAndPFromUrl(targetTab.url || "");
          const matchedInFolder = parsed
            ? (playable.find(t => t.bvid === parsed.bvid && t.p === parsed.p) || playable.find(t => t.bvid === parsed.bvid))
            : null;

          if (matchedInFolder && parsed && parsed.isCleanVideoPage) {
            // 当前标签页已经在播放歌单里的某首纯视频页，直接接管并自动开播
            state.currentTrack = matchedInFolder;
            await saveState(state);
            await notifyTabMusicMode(targetTab.id, true, state);
          } else {
            // /list/ml... 连播页或其他 B 站视频页：跳到纯粹的单视频页接管播放
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
            adoptedCurrentTab: true,
            playableCount: playable.length
          });
          break;
        }

        // 情况 2：已经有听歌标签页在运行 —— 直接复用它，不新开也不碰当前页
        if (existingMusicTab) {
          const parsedExisting = parseBvidAndPFromUrl(existingMusicTab.url || "");
          const matchedExisting = parsedExisting
            ? (playable.find(t => t.bvid === parsedExisting.bvid && t.p === parsedExisting.p)
              || playable.find(t => t.bvid === parsedExisting.bvid))
            : null;

          if (matchedExisting) {
            state.currentTrack = matchedExisting;
            await saveState(state);
          } else {
            const trackToPlay = chooseNextTrack(state) || playable[0];
            state.currentTrack = trackToPlay;
            await saveState(state);
            if (trackToPlay) {
              await navigateMusicTabToTrack(state, trackToPlay);
            }
          }
          await activateTab(existingMusicTab);
          sendResponse({
            ok: true,
            state,
            reusedExistingTab: true,
            playableCount: playable.length
          });
          break;
        }

        // 情况 3：当前页不是 B 站视频页（网课、文档、搜索结果……）—— 新开一个标签页听歌，绝不覆盖当前页
        const trackToPlay = chooseNextTrack(state) || playable[0];
        if (!trackToPlay) {
          sendResponse({ ok: false, error: "歌单里没有可播放的歌曲", state });
          break;
        }
        const createdTab = await openMusicTabWithTrack(state, trackToPlay, { active: true });
        if (!createdTab) {
          sendResponse({ ok: false, error: "新标签页打开失败，请检查浏览器是否拦截了新建标签页", state });
          break;
        }

        sendResponse({
          ok: true,
          state,
          openedNewTab: true,
          newTabId: createdTab.id,
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
        const { bvid, p = 1 } = msg;
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

          // 已有听歌标签页就地切歌；没有的话新开一个标签页，绝不覆盖当前正在看的页面
          const existingMusicTab = await getTabSafely(state.musicTabId);
          if (existingMusicTab) {
            await navigateMusicTabToTrack(state, track);
            await activateTab(existingMusicTab);
            sendResponse({ ok: true, state, reusedExistingTab: true });
            break;
          }

          const createdTab = await openMusicTabWithTrack(state, track, { active: true });
          if (!createdTab) {
            sendResponse({ ok: false, error: "新标签页打开失败，请检查浏览器是否拦截了新建标签页", state });
            break;
          }
          sendResponse({ ok: true, state, openedNewTab: true, newTabId: createdTab.id });
          break;
        }
        sendResponse({ ok: false, error: "歌单里找不到这首歌，请先同步收藏夹", state });
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
