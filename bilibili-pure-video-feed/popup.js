// popup.js - B站首页纯净视频过滤开关面板

(() => {
  const DEFAULT_SETTINGS = {
    enabled: true,
    live: true,
    docOgv: true,
    animeManga: true,
    specialFloor: true,
    adPromo: true,
    strictBvOnly: true,
    hideSwipe: false
  };

  let settings = Object.assign({}, DEFAULT_SETTINGS);

  const enabledInput = document.getElementById("enabled");
  const statusDot = document.getElementById("statusDot");
  const statBar = document.getElementById("statBar");
  const rulesCard = document.getElementById("rulesCard");
  const ruleCheckboxes = Array.from(document.querySelectorAll("input[data-key]"));

  function renderSettings() {
    enabledInput.checked = Boolean(settings.enabled);
    statusDot.classList.toggle("off", !settings.enabled);
    rulesCard.classList.toggle("disabled", !settings.enabled);

    for (const cb of ruleCheckboxes) {
      const key = cb.dataset.key;
      cb.checked = Boolean(settings[key]);
    }

    if (!settings.enabled) {
      statBar.textContent = "已暂停过滤，首页显示全部原生内容";
    }
  }

  function saveSettings() {
    chrome.storage.local.set({ pureFeedSettings: settings }, () => {
      refreshActiveTabStats();
    });
  }

  function refreshActiveTabStats() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs?.[0];
      if (!tab?.id) return;
      chrome.tabs.sendMessage(tab.id, { type: "GET_FILTER_STATS" }, (res) => {
        if (chrome.runtime.lastError || !res?.ok) {
          if (settings.enabled) {
            statBar.textContent = "过滤已开启（打开B站首页即可自动过滤非视频卡片）";
          }
          return;
        }
        const st = res.stats || {};
        if (settings.enabled) {
          statBar.textContent = `当前页已过滤 ${st.total || 0} 个非普通视频卡片`;
        }
        const keys = ["live", "docOgv", "animeManga", "specialFloor", "adPromo", "strictBvOnly"];
        for (const k of keys) {
          const el = document.getElementById(`count-${k}`);
          if (el) el.textContent = String(st[k] || 0);
        }
      });
    });
  }

  enabledInput.onchange = () => {
    settings.enabled = enabledInput.checked;
    renderSettings();
    saveSettings();
  };

  for (const cb of ruleCheckboxes) {
    cb.onchange = () => {
      const key = cb.dataset.key;
      settings[key] = cb.checked;
      saveSettings();
    };
  }

  chrome.storage.local.get("pureFeedSettings", (res) => {
    if (res?.pureFeedSettings) {
      settings = Object.assign({}, DEFAULT_SETTINGS, res.pureFeedSettings);
    } else {
      chrome.storage.local.set({ pureFeedSettings: settings });
    }
    renderSettings();
    refreshActiveTabStats();
  });
})();
