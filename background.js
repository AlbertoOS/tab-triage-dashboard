// Tab Triage — background script
// Opens the triage page on browser action click and provides tab data

browser.browserAction.onClicked.addListener(() => {
  browser.tabs.create({ url: browser.runtime.getURL("triage.html") });
});

// Respond to data requests from the triage page
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "getTabs") {
    browser.tabs.query({}).then((tabs) => {
      sendResponse({ tabs });
    });
    return true; // async response
  }
  if (msg.type === "goToTab") {
    browser.tabs.update(msg.tabId, { active: true });
    browser.windows.update(msg.windowId, { focused: true });
  }
  if (msg.type === "closeTab") {
    browser.tabs.remove(msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "closeTabs") {
    browser.tabs.remove(msg.tabIds).then(() => sendResponse({ ok: true }));
    return true;
  }
});
