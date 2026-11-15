// content.js - B站首页纯净视频过滤（只保留普通UP主投稿视频）

(() => {
  const DEFAULT_SETTINGS = {
    enabled: true,
    live: true,          // 过滤直播
    docOgv: true,        // 过滤纪录片 / 影视剧 / 电影 / 综艺
    animeManga: true,    // 过滤动漫 / 番剧 / 国创 / 漫画
    specialFloor: true,  // 过滤带叠层底板的特殊频道卡 / 课堂 / 专栏 / 活动
    adPromo: true,       // 过滤商业广告与推广
    strictBvOnly: true,  // 严格只留普通 /video/BV 投稿视频
    hideSwipe: false     // 可选：隐藏首页左上角大图轮播
  };

  let settings = Object.assign({}, DEFAULT_SETTINGS);

  const stats = {
    total: 0,
    live: 0,
    docOgv: 0,
    animeManga: 0,
    specialFloor: 0,
    adPromo: 0,
    strictBvOnly: 0
  };

  // 记录已处理过的网格节点及其被拦截的原因，支持随时在面板开关实时恢复/隐藏
  const processedCells = new WeakMap();

  const LIVE_BADGES = new Set(["直播", "直播中", "预约直播"]);
  const DOC_OGV_BADGES = new Set(["纪录片", "电影", "电视剧", "综艺", "影视", "纪录", "短剧"]);
  const ANIME_MANGA_BADGES = new Set(["番剧", "国创", "漫画", "动漫", "动画", "连载动画", "完结动画"]);
  const SPECIAL_BADGES = new Set(["课堂", "专栏", "活动", "游戏", "会员购", "音频", "歌单", "话题", "赛事"]);
  const AD_BADGES = new Set(["广告", "推广", "商业推广", "创作推广"]);

  function isHomePage() {
    return (
      location.hostname === "www.bilibili.com" &&
      (location.pathname === "/" || location.pathname === "/index.html")
    );
  }

  function injectBaseStyles() {
    if (document.getElementById("bili-pure-video-feed-style")) return;
    const style = document.createElement("style");
    style.id = "bili-pure-video-feed-style";
    style.textContent = `
      [data-bili-pure-hidden]:not([data-bili-pure-hidden=""]) {
        display: none !important;
      }
      html[data-bili-pure-hide-swipe="1"] .recommended-swipe {
        display: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // 找到卡片在首页网格中的最外层容器（确保隐藏后CSS Grid自动往前补位，不留空白洞）
  function getGridCell(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.classList.contains("recommended-swipe")) return null;
    const wrapper = el.closest(".feed-card, .bili-feed-card");
    if (wrapper) return wrapper;
    const card = el.closest(".floor-single-card, .bili-live-card, .bili-video-card");
    return card || null;
  }

  // 提取卡片内所有短标签/角标文字
  function collectBadgeTexts(cell) {
    const texts = new Set();
    const candidates = cell.querySelectorAll(
      '.floor-card-badge, [class*="badge"], .bili-live-card__info--living, .bili-video-card__info--ad, .bili-video-card__stats--text, span, div'
    );
    for (const node of candidates) {
      if (node.children.length === 0) {
        const t = (node.textContent || "").trim();
        if (t && t.length <= 6) {
          texts.add(t);
        }
      }
    }
    return texts;
  }

  // 判断一个已经加载出内容的卡片是否应该被过滤，返回分类原因（null 表示正常普通视频）
  function detectFilterReason(cell) {
    if (!cell) return null;

    const links = Array.from(cell.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") || "");
    const hasAdNode = Boolean(
      cell.querySelector('.bili-video-card__info--ad, .vcd, [class*="--ad"], .ad-report, .bili-Commercial')
    );
    const isLiveClass =
      cell.classList.contains("bili-live-card") ||
      Boolean(cell.querySelector('.bili-live-card, [class*="live-card"]'));
    const isFloorSingleClass =
      cell.classList.contains("floor-single-card") ||
      Boolean(cell.querySelector(".floor-single-card, .floor-card-single, .layer"));

    // 如果卡片还在骨架屏加载阶段（没有任何链接且没有任何特征类），暂不处理，等加载完成再判断
    if (links.length === 0 && !hasAdNode && !isLiveClass && !isFloorSingleClass) {
      return "PENDING";
    }

    const badges = collectBadgeTexts(cell);
    const hasBadgeIn = (set) => {
      for (const b of badges) {
        if (set.has(b)) return true;
      }
      return false;
    };

    const hasLiveUrl = links.some((u) => u.includes("live.bilibili.com"));
    const hasBangumiUrl = links.some((u) => /bilibili\.com\/bangumi\/play\//.test(u) || u.startsWith("/bangumi/play/"));
    const hasMangaUrl = links.some((u) => u.includes("manga.bilibili.com"));
    const hasSpecialUrl = links.some((u) =>
      /\/cheese\/|\/read\/|show\.bilibili\.com|game\.bilibili\.com|\/blackboard\/|\/v\/popular\//.test(u)
    );
    const hasAdUrl = links.some((u) => u.includes("cm.bilibili.com"));
    const hasBvVideoUrl = links.some((u) => /\/video\/BV[0-9A-Za-z]+/.test(u));
    const hasSpaceOwnerUrl = links.some((u) => u.includes("space.bilibili.com"));

    // 1. 广告与推广
    if (hasAdNode || hasAdUrl || hasBadgeIn(AD_BADGES)) {
      return "adPromo";
    }

    // 2. 直播
    if (isLiveClass || hasLiveUrl || hasBadgeIn(LIVE_BADGES)) {
      return "live";
    }

    // 3. 动漫 / 番剧 / 国创 / 漫画
    if (hasMangaUrl || hasBadgeIn(ANIME_MANGA_BADGES)) {
      return "animeManga";
    }

    // 4. 纪录片 / 电影 / 电视剧 / 综艺 (OGV)
    if (hasBadgeIn(DOC_OGV_BADGES) || hasBangumiUrl) {
      return "docOgv";
    }

    // 5. 特殊叠层卡片（如切尔诺贝利、进化、排球少年底下带多层白底板的推流卡，以及课堂/专栏/活动）
    if (isFloorSingleClass || hasSpecialUrl || hasBadgeIn(SPECIAL_BADGES)) {
      return "specialFloor";
    }

    // 6. 严格只留普通投稿视频（必须包含 /video/BV 链接且包含 UP 主个人空间链接）
    if (!hasBvVideoUrl || !hasSpaceOwnerUrl) {
      return "strictBvOnly";
    }

    return "KEEP";
  }

  function shouldHideByReason(reason) {
    if (!settings.enabled) return false;
    if (!reason || reason === "KEEP" || reason === "PENDING") return false;
    if (reason === "live") return Boolean(settings.live);
    if (reason === "docOgv") return Boolean(settings.docOgv);
    if (reason === "animeManga") return Boolean(settings.animeManga);
    if (reason === "specialFloor") return Boolean(settings.specialFloor);
    if (reason === "adPromo") return Boolean(settings.adPromo);
    if (reason === "strictBvOnly") return Boolean(settings.strictBvOnly);
    return false;
  }

  function recomputeStats() {
    stats.total = 0;
    stats.live = 0;
    stats.docOgv = 0;
    stats.animeManga = 0;
    stats.specialFloor = 0;
    stats.adPromo = 0;
    stats.strictBvOnly = 0;

    const allHidden = document.querySelectorAll("[data-bili-pure-hidden]");
    for (const el of allHidden) {
      const r = el.getAttribute("data-bili-pure-hidden");
      if (r && stats[r] !== undefined) {
        stats[r] += 1;
        stats.total += 1;
      }
    }
  }

  function evaluateCell(cell) {
    if (!cell || cell.classList.contains("recommended-swipe")) return;
    const reason = detectFilterReason(cell);
    if (reason === "PENDING") return;

    processedCells.set(cell, reason);
    if (shouldHideByReason(reason)) {
      if (cell.getAttribute("data-bili-pure-hidden") !== reason) {
        cell.setAttribute("data-bili-pure-hidden", reason);
      }
    } else {
      if (cell.hasAttribute("data-bili-pure-hidden")) {
        cell.removeAttribute("data-bili-pure-hidden");
      }
    }
  }

  function scanAllCards() {
    if (!isHomePage()) return;
    injectBaseStyles();

    if (settings.enabled && settings.hideSwipe) {
      document.documentElement.setAttribute("data-bili-pure-hide-swipe", "1");
    } else {
      document.documentElement.removeAttribute("data-bili-pure-hide-swipe");
    }

    const candidates = document.querySelectorAll(
      ".feed-card, .bili-feed-card, .floor-single-card, .bili-live-card, .bili-video-card"
    );
    const uniqueCells = new Set();
    for (const el of candidates) {
      const cell = getGridCell(el);
      if (cell) uniqueCells.add(cell);
    }

    for (const cell of uniqueCells) {
      evaluateCell(cell);
    }

    recomputeStats();
  }

  // 加载配置
  chrome.storage.local.get("pureFeedSettings", (res) => {
    if (res?.pureFeedSettings) {
      settings = Object.assign({}, DEFAULT_SETTINGS, res.pureFeedSettings);
    }
    scanAllCards();
  });

  // 监听配置修改，实时生效无需刷新
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.pureFeedSettings) {
      settings = Object.assign({}, DEFAULT_SETTINGS, changes.pureFeedSettings.newValue || {});
      scanAllCards();
    }
  });

  // 监听首页滚动加载与“换一换/刷新内容”产生的动态卡片
  const observer = new MutationObserver((mutations) => {
    if (!isHomePage()) return;
    let shouldRescan = false;
    for (const m of mutations) {
      if (m.addedNodes && m.addedNodes.length > 0) {
        shouldRescan = true;
        break;
      }
    }
    if (shouldRescan) {
      scanAllCards();
    }
  });

  function startObserver() {
    injectBaseStyles();
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
    scanAllCards();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserver, { once: true });
  } else {
    startObserver();
  }

  // 定时兜底扫描（处理骨架屏延迟渲染完成后的卡片）
  setInterval(() => {
    if (isHomePage()) {
      scanAllCards();
    }
  }, 800);

  // 响应弹窗面板的数据查询
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "GET_FILTER_STATS") {
      scanAllCards();
      sendResponse({
        ok: true,
        stats,
        settings
      });
      return false;
    }
    return false;
  });
})();
