// Tab Triage — background script
// Opens the triage page on browser action click and provides tab data

// Cross-browser compatibility: Firefox exposes `browser`, Chrome exposes `chrome`
const api = globalThis.browser || chrome;

api.action.onClicked.addListener(() => {
  api.tabs.create({ url: api.runtime.getURL("triage.html") });
});

// Respond to data requests from the triage page
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "getTabs") {
    api.tabs.query({}).then((tabs) => {
      sendResponse({ tabs });
    });
    return true; // async response
  }
  if (msg.type === "goToTab") {
    api.tabs.update(msg.tabId, { active: true });
    api.windows.update(msg.windowId, { focused: true });
  }
  if (msg.type === "closeTab") {
    api.tabs.remove(msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "closeTabs") {
    // Tabs may have been closed elsewhere since the dashboard was refreshed.
    api.tabs.query({}).then(async (tabs) => {
      const dashboardUrl = api.runtime.getURL("triage.html");
      const requestedIds = new Set(msg.tabIds);
      const tabIds = tabs
        .filter((tab) => requestedIds.has(tab.id) &&
          (tab.url || "").split(/[?#]/)[0] !== dashboardUrl)
        .map((tab) => tab.id);
      if (tabIds.length > 0) await api.tabs.remove(tabIds);
      sendResponse({ ok: true });
    }).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});
