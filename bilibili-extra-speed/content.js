(() => {
  'use strict';

  // 想改档位，只改这一行即可（支持 0.25 ~ 16 之间的小数）。
  // 4x 是 Chromium 还能保留声音的最高档；4.5x/5x 会被浏览器静音。
  const EXTRA_RATES = [2.5, 3, 4, 4.5, 5];

  const MENU_SELECTOR = '.bpx-player-ctrl-playbackrate-menu';
  const ITEM_SELECTOR = '.bpx-player-ctrl-playbackrate-menu-item';
  const CONTAINER_SELECTOR = '.bpx-player-ctrl-playbackrate';
  const ACTIVE_CLASS = 'bpx-state-active';
  const SHOW_CLASS = 'bpx-state-show';
  const MARK_ATTR = 'data-bili-extra-speed';

  // Bilibili shows integer rates as "3.0x" and decimals as "4.5x".
  const formatRate = (rate) =>
    `${Number.isInteger(rate) ? rate.toFixed(1) : rate}x`;

  function getVideo(menu) {
    const container = menu.closest(CONTAINER_SELECTOR);
    const player = container && container.closest('.bpx-player-container');
    const scope = player || container || document;
    return (
      scope.querySelector('video, bwp-video') ||
      document.querySelector('video, bwp-video')
    );
  }

  function markActive(menu, rate) {
    for (const item of menu.querySelectorAll(ITEM_SELECTOR)) {
      const active = Number(item.dataset.value) === rate;
      if (item.classList.contains(ACTIVE_CLASS) !== active) {
        item.classList.toggle(ACTIVE_CLASS, active);
      }
    }
  }

  function applyRate(menu, rate) {
    const video = getVideo(menu);
    if (!video) return;

    video.playbackRate = rate;
    // Bilibili's own setPlaybackRate() writes both properties.
    video.defaultPlaybackRate = rate;

    markActive(menu, rate);
    // Bilibili's click handler normally closes the menu. We stop that handler
    // below (it clamps rates to 4x), so close the menu ourselves.
    const container = menu.closest(CONTAINER_SELECTOR);
    if (container) container.classList.remove(SHOW_CLASS);
  }

  function createItem(menu, rate, template) {
    const item = template.cloneNode(true);
    item.removeAttribute('id');
    item.classList.remove(ACTIVE_CLASS);
    item.setAttribute(MARK_ATTR, '1');
    item.dataset.value = String(rate);
    item.textContent = formatRate(rate);

    item.addEventListener('click', (event) => {
      // Bilibili delegates clicks on the whole menu and routes every <li>
      // through settingStore.setPlaybackRate(), which clamps to 0.25–4x.
      // Keep 4.5x/5x intact by handling this click ourselves.
      event.preventDefault();
      event.stopPropagation();
      applyRate(menu, rate);
    });

    return item;
  }

  function ensureMenu(menu) {
    const items = [...menu.querySelectorAll(ITEM_SELECTOR)];
    if (items.length === 0) return;

    // Remove our items if the configured list changed after an extension
    // reload (content scripts keep running until the page is reloaded).
    for (const item of items) {
      if (!item.hasAttribute(MARK_ATTR)) continue;
      if (!EXTRA_RATES.includes(Number(item.dataset.value))) item.remove();
    }

    const present = new Set(
      [...menu.querySelectorAll(ITEM_SELECTOR)].map((item) =>
        Number(item.dataset.value),
      ),
    );

    // Clone a native item so our entries inherit the player's exact styling
    // across normal/fullscreen/web-fullscreen/mini-player modes.
    const template = [...menu.querySelectorAll(ITEM_SELECTOR)].find(
      (item) => !item.hasAttribute(MARK_ATTR),
    );
    if (!template) return;

    let added = false;
    for (const rate of EXTRA_RATES) {
      if (present.has(rate)) continue;

      const item = createItem(menu, rate, template);
      // Native menu is sorted high -> low. Put each new entry above the first
      // entry slower than it.
      const next = [...menu.querySelectorAll(ITEM_SELECTOR)].find((node) => {
        const value = Number(node.dataset.value);
        return Number.isFinite(value) && value < rate;
      });
      menu.insertBefore(item, next || null);
      added = true;
    }

    if (!added) return;

    const video = getVideo(menu);
    if (video) markActive(menu, video.playbackRate);
  }

  function scan() {
    for (const menu of document.querySelectorAll(MENU_SELECTOR)) {
      ensureMenu(menu);
    }
  }

  // Bilibili re-renders its player controls on SPA navigation and fullscreen
  // changes. A throttled observer plus a slow poll keeps our entries mounted.
  let scanTimer = 0;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = window.setTimeout(() => {
      scanTimer = 0;
      scan();
    }, 200);
  }

  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  window.setInterval(scan, 1000);
  document.addEventListener('fullscreenchange', scheduleScan, true);
  document.addEventListener('webkitfullscreenchange', scheduleScan, true);

  scan();
})();
