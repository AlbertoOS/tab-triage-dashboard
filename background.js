// Tab Triage — background script
// Opens the triage page on browser action click and provides tab data

// Cross-browser compatibility: Firefox exposes `browser`, Chrome exposes `chrome`
const api = globalThis.browser || chrome;

// Firefox uses browserAction (MV2), Chrome MV3 uses action
const browserAction = api.browserAction || api.action;

browserAction.onClicked.addListener(() => {
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
    api.tabs.remove(msg.tabIds).then(() => sendResponse({ ok: true }));
    return true;
  }
});
