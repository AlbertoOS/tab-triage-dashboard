// Tab Triage — background script
// Cross-browser compatibility: Firefox exposes `browser`, Chrome exposes `chrome`
const api = globalThis.browser || chrome;

// Chromium workers must declare imported scripts during initial evaluation.
if (typeof importScripts === "function") importScripts("utils.js");

let closingTabs = false;
let duplicateToolsLoading;

async function loadDuplicateTools() {
  if (!globalThis.duplicateTools) {
    if (!duplicateToolsLoading) {
      duplicateToolsLoading = (async () => {
        if (typeof importScripts === "function") importScripts("utils.js");
        else await import("./utils.js");
      })().catch((error) => { duplicateToolsLoading = undefined; throw error; });
    }
    await duplicateToolsLoading;
  }
  return globalThis.duplicateTools;
}

function validDuplicatePlan(plan) {
  const validId = (id) => Number.isSafeInteger(id) && id >= 0;
  const ids = new Set();
  const keys = new Set();
  if (!plan || typeof plan !== "object" || !["global", "keep", "closeAll"].includes(plan.mode) ||
      !Array.isArray(plan.groups)) return false;
  return Array.from(plan.groups).every((group) => {
    if (!group || typeof group.key !== "string" || !group.key.trim() || keys.has(group.key) ||
        !Array.isArray(group.keeperIds) || !Array.isArray(group.candidates) ||
        (plan.mode === "closeAll" ? group.keeperIds.length !== 0 : group.keeperIds.length === 0) ||
        (plan.mode === "keep" && group.keeperIds.length !== 1)) return false;
    keys.add(group.key);
    for (const id of group.keeperIds) {
      if (!validId(id) || ids.has(id)) return false;
      ids.add(id);
    }
    return Array.from(group.candidates).every((tab) => {
      if (!tab || !validId(tab.id) || ids.has(tab.id) || !validId(tab.windowId) ||
          typeof tab.url !== "string" || !tab.url.trim() ||
          typeof tab.pinned !== "boolean" || typeof tab.active !== "boolean") return false;
      ids.add(tab.id);
      return true;
    });
  });
}

async function executeDuplicatePlan(plan) {
  const { normalizeUrl, isDashboardTab } = await loadDuplicateTools();
  // Reject inconsistent identities before the first browser API call.
  if (plan.groups.some((group) => group.candidates.some((tab) => normalizeUrl(tab.url) !== group.key))) {
    throw new Error("Invalid duplicate identity.");
  }
  const dashboardUrl = api.runtime.getURL("triage.html");
  const result = { ok: true, closedCount: 0, skippedCount: 0, failedCount: 0, unverifiedCount: 0 };
  // Observe only the exact removal currently being attempted, not a stale or
  // unrelated event. A remove promise alone is not proof that a tab closed.
  let removingId;
  let removalObserved = false;
  const onRemoved = (id) => { if (id === removingId) removalObserved = true; };
  const removalEvents = api.tabs.onRemoved;
  const observeRemovals = !!removalEvents?.addListener && !!removalEvents?.removeListener;
  if (observeRemovals) removalEvents.addListener(onRemoved);
  try {
    for (const group of plan.groups) {
      // Cache a preferred identity only; its live state is read before every close.
      let preferredKeeper = group.keeperIds[0];
      for (const candidate of group.candidates) {
        try {
          let inventory;
          const readTab = async (id) => {
            if (!inventory && typeof api.tabs.get === "function") {
              try { return await api.tabs.get(id); } catch { /* Absence and API failure are ambiguous. */ }
            }
            if (!inventory) inventory = await api.tabs.query({});
            return inventory.find((tab) => tab.id === id);
          };
          // Firefox can expose the previous URL while loading without pendingUrl.
          // Do not close a candidate or rely on a keeper with an unknown destination.
          const matches = (tab) => tab && (tab.status !== "loading" || !!tab.pendingUrl) &&
            normalizeUrl(tab.url) === group.key &&
            (!tab.pendingUrl || normalizeUrl(tab.pendingUrl) === group.key);
          let keeperLives = plan.mode === "closeAll";
          if (!keeperLives) {
            if (matches(await readTab(preferredKeeper))) keeperLives = true;
            else {
              for (const id of group.keeperIds) {
                if (id !== preferredKeeper && matches(await readTab(id))) {
                  preferredKeeper = id;
                  keeperLives = true;
                  break;
                }
              }
            }
          }
          const tab = await readTab(candidate.id);
          if (!matches(tab) || tab.url !== candidate.url || tab.windowId !== candidate.windowId || !keeperLives ||
              isDashboardTab(tab, dashboardUrl) ||
              (plan.mode === "global" ? tab.pinned || tab.active :
                (tab.pinned && !candidate.pinned) || (tab.active && !candidate.active))) {
            result.skippedCount++;
            continue;
          }
          // Browser APIs have no atomic read-and-remove. These fresh checks narrow,
          // but cannot eliminate, navigation/activation races after the final read.
          removingId = candidate.id;
          removalObserved = false;
          try { await api.tabs.remove(candidate.id); } catch { /* Readback determines the actual outcome. */ }
          try {
            let remains;
            if (removalObserved) remains = false;
            else if (observeRemovals && typeof api.tabs.get === "function") {
              try { await api.tabs.get(candidate.id); remains = true; } catch {
                // The event and promise can arrive in different tasks. Yield once,
                // not indefinitely: a missing/late event still needs query readback.
                await new Promise((resolve) => setTimeout(resolve, 0));
                if (removalObserved) remains = false;
              }
            }
            if (remains === undefined) {
              remains = (await api.tabs.query({})).some((tab) => tab.id === candidate.id);
            }
            if (!remains) result.closedCount++;
            else result.failedCount++;
          } catch {
            result.unverifiedCount++;
          } finally {
            removingId = undefined;
          }
        } catch {
          result.failedCount++;
        }
      }
    }
    return result;
  } finally {
    if (observeRemovals) removalEvents.removeListener(onRemoved);
  }
}

const openingDashboards = new Map();

api.action.onClicked.addListener((clickedTab) => {
  // Chrome spanning mode hosts packaged extension pages in regular windows.
  // Chromium can expose both API aliases; use this package's manifest instead.
  const manifest = api.runtime.getManifest();
  const incognito = !!clickedTab?.incognito &&
    (!!manifest.browser_specific_settings?.gecko || manifest.incognito === "split");
  if (openingDashboards.has(incognito)) return openingDashboards.get(incognito);
  const opening = (async () => {
    const url = api.runtime.getURL("triage.html");
    const dashboards = (await api.tabs.query({})).filter((tab) =>
      !!tab.incognito === incognito &&
      (tab.pendingUrl || tab.url || "").split(/[?#]/)[0] === url);
    const dashboard = dashboards.find((tab) => tab.windowId === clickedTab?.windowId) || dashboards[0];
    if (dashboard) {
      const activated = await api.tabs.update(dashboard.id, { active: true });
      await api.windows.update(activated.windowId, { focused: true });
      // Extension pages receive runtime broadcasts, except the sending context.
      // The selected dashboard alone handles this notification, even if active.
      try {
        const response = await api.runtime.sendMessage({ type: "refreshDashboard", tabId: dashboard.id });
        if (response?.ok !== true) throw new Error(response?.error || "Dashboard did not acknowledge refresh.");
      } catch (error) {
        // Pending navigation may not have a receiver yet; initial load reads tabs.
        console.error("Could not refresh Tab Triage:", error?.message || "Browser operation failed.");
      }
    } else {
      const properties = { url, active: true };
      if (Number.isSafeInteger(clickedTab?.windowId) && incognito === !!clickedTab?.incognito) {
        properties.windowId = clickedTab.windowId;
      }
      const created = await api.tabs.create(properties);
      await api.windows.update(created.windowId, { focused: true });
    }
  })().catch((error) => {
    console.error("Could not open Tab Triage:", error?.message || "Browser operation failed.");
  }).finally(() => openingDashboards.delete(incognito));
  // Share in-flight opens by the context that can actually host the dashboard.
  openingDashboards.set(incognito, opening);
  return opening;
});

// Keep the message channel open; every supported command returns a structured result.
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const validId = (id) => Number.isSafeInteger(id) && id >= 0;
  const commands = ["getTabs", "goToTab", "closeTab", "closeTabs", "discardTab", "restoreTab", "previewDuplicates", "closeDuplicates"];
  if (!msg || typeof msg !== "object" || !commands.includes(msg.type) ||
      (["closeTab", "discardTab", "goToTab"].includes(msg.type) && !validId(msg.tabId)) ||
      (msg.type === "goToTab" && !validId(msg.windowId)) ||
      (msg.type === "closeTabs" && (!Array.isArray(msg.tabIds) || !msg.tabIds.every(validId))) ||
      (msg.type === "closeDuplicates" && (!validDuplicatePlan(msg.plan) ||
        Object.keys(msg).some((key) => !["type", "plan"].includes(key)))) ||
      (msg.type === "previewDuplicates" && Object.keys(msg).some((key) => key !== "type"))) {
    sendResponse({ ok: false, error: "Invalid command or arguments." });
    return false;
  }
  const isClose = ["closeTab", "closeTabs", "closeDuplicates"].includes(msg.type);
  if (isClose && closingTabs) {
    sendResponse({ ok: false, error: "Another tab closure is in progress." });
    return false;
  }
  if (isClose) closingTabs = true;
  (async () => {
    switch (msg.type) {
      case "previewDuplicates": {
        const { buildDuplicatePlan } = await loadDuplicateTools();
        return { ok: true, plan: buildDuplicatePlan(await api.tabs.query({}), "global", api.runtime.getURL("triage.html")) };
      }
      case "closeDuplicates":
        return executeDuplicatePlan(msg.plan);
      case "getTabs":
        return { ok: true, tabs: await api.tabs.query({}) };
      case "goToTab": {
        const activated = await api.tabs.update(msg.tabId, { active: true });
        await api.windows.update(activated.windowId, { focused: true });
        break;
      }
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
            ![tab.url, tab.pendingUrl].some((url) => (url || "").split(/[?#]/)[0] === dashboardUrl))
          .map((tab) => tab.id);
        if (tabIds.length > 0) await api.tabs.remove(tabIds);
        break;
      }
      case "discardTab": {
        const tab = await api.tabs.get(msg.tabId);
        if (tab.active) throw new Error("The active tab cannot be discarded.");
        if (tab.discarded) break; // Already at the requested state: idempotent success.
        const discardedTab = await api.tabs.discard(msg.tabId);
        // Firefox fulfills with void even for a no-op; activation can also race
        // the guard. Chrome may return a replacement tab ID. Verify current state.
        const discardedId = validId(discardedTab?.id) ? discardedTab.id : msg.tabId;
        if (!(await api.tabs.get(discardedId)).discarded) {
          throw new Error("The tab was not discarded. It may be active or protected by the browser.");
        }
        break;
      }
      case "restoreTab":
        if (!api.sessions?.restore) throw new Error("Session restoration is unavailable.");
        // The browser chooses the most recent session, which can be a whole window.
        await api.sessions.restore();
        break;
    }
    return { ok: true };
  })().then((result) => {
    if (isClose) closingTabs = false;
    sendResponse(result);
  }).catch((error) => {
    if (isClose) closingTabs = false;
    sendResponse({ ok: false, error: error?.message || "Browser operation failed." });
  });
  return true;
});
