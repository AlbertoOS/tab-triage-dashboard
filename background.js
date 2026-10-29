// Tab Triage — background script
// Cross-browser compatibility: Firefox exposes `browser`, Chrome exposes `chrome`
const api = globalThis.browser || chrome;

api.action.onClicked.addListener(async () => {
  try {
    await api.tabs.create({ url: api.runtime.getURL("triage.html") });
  } catch (error) {
    console.error("Could not open Tab Triage:", error?.message || "Browser operation failed.");
  }
});

// Keep the message channel open; every supported command returns a structured result.
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const validId = (id) => Number.isSafeInteger(id) && id >= 0;
  const commands = ["getTabs", "goToTab", "closeTab", "closeTabs", "discardTab", "restoreTab"];
  if (!msg || typeof msg !== "object" || !commands.includes(msg.type) ||
      (["closeTab", "discardTab", "goToTab"].includes(msg.type) && !validId(msg.tabId)) ||
      (msg.type === "goToTab" && !validId(msg.windowId)) ||
      (msg.type === "closeTabs" && (!Array.isArray(msg.tabIds) || !msg.tabIds.every(validId)))) {
    sendResponse({ ok: false, error: "Invalid command or arguments." });
    return false;
  }
  (async () => {
    switch (msg.type) {
      case "getTabs":
        return { ok: true, tabs: await api.tabs.query({}) };
      case "goToTab":
        await api.tabs.update(msg.tabId, { active: true });
        await api.windows.update(msg.windowId, { focused: true });
        break;
      case "closeTab":
        await api.tabs.remove(msg.tabId);
        break;
      case "closeTabs": {
        // Tabs may have been closed elsewhere since the dashboard was refreshed.
        const tabs = await api.tabs.query({});
        const dashboardUrl = api.runtime.getURL("triage.html");
        const requestedIds = new Set(msg.tabIds);
        const tabIds = tabs
          .filter((tab) => requestedIds.has(tab.id) &&
            (tab.url || "").split(/[?#]/)[0] !== dashboardUrl)
          .map((tab) => tab.id);
        if (tabIds.length > 0) await api.tabs.remove(tabIds);
        break;
      }
      case "discardTab":
        await api.tabs.discard(msg.tabId);
        break;
      case "restoreTab":
        if (!api.sessions?.restore) throw new Error("Session restoration is unavailable.");
        // The browser chooses the most recent session, which can be a whole window.
        await api.sessions.restore();
        break;
    }
    return { ok: true };
  })().then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: error?.message || "Browser operation failed." });
  });
  return true;
});
