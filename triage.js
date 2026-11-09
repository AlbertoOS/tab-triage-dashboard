// Tab Triage Dashboard — triage page logic
// Pure utility functions are in utils.js (loaded before this file)

// Cross-browser compatibility: Firefox exposes `browser`, Chrome exposes `chrome`
const api = globalThis.browser || chrome;

let allTabs = [];
let enrichedTabs = [];
let currentSort = []; // Array of { key, dir } for multi-column sort
let collapsedGroups = new Set();
let ignoredUrls = new Set();
let ignoredDomains = new Set();
let ignoreEditRevision = 0;
let pendingIgnoreSaves = 0;
let showIgnored = false;
let fuzzySearch = false;
let selectedTabIds = new Set();
let closingSelected = false;
let closingTabAction = false;

// --- Data ---

async function sendCommand(message) {
  const response = await api.runtime.sendMessage(message);
  if (response?.ok !== true) throw new Error(response?.error || "Invalid browser response.");
  return response;
}

function reportError(message) {
  const status = document.getElementById("bulkError");
  status.textContent = status.textContent ? `${status.textContent} ${message}` : message;
}

async function refreshTabs() {
  document.getElementById("bulkError").textContent = "";
  return loadTabs();
}

async function runTabAction(message, successMessage) {
  const isClose = message.type === "closeTab" || message.type === "closeTabs";
  if (isClose && (closingTabAction || closingDuplicates || closingSelected)) return;
  if (isClose) closingTabAction = true;
  document.getElementById("bulkError").textContent = "";
  try {
    await sendCommand(message);
    if (successMessage) showUndoToast(successMessage);
  } catch (error) {
    reportError(`Could not complete tab action: ${error.message}`);
  } finally {
    // Operations can partly succeed before the browser rejects them.
    await loadTabs();
    if (isClose) closingTabAction = false;
  }
}

let inventoryLoading = false;
let queuedLoad;

function loadTabs(shouldReportError = () => true, automatic = false) {
  if (!queuedLoad) {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    queuedLoad = { promise, resolve };
  }
  Object.assign(queuedLoad, {
    shouldReportError,
    automatic,
    ignoreRevision: ignoreEditRevision,
    ignoreSavePending: pendingIgnoreSaves > 0,
  });
  const promise = queuedLoad.promise;
  if (!inventoryLoading) drainInventoryLoads();
  return promise;
}

async function drainInventoryLoads() {
  inventoryLoading = true;
  clearTimeout(automaticTimer);
  automaticTimer = undefined;
  while (queuedLoad) {
    const request = queuedLoad;
    queuedLoad = undefined;
    if (!request.automatic) {
      inventoryDirty = false;
      automaticReconcile = false;
    }
    let result;
    try {
      const ignoreLists = await loadIgnoreLists();
      const response = await sendCommand({ type: "getTabs" });
      if (!Array.isArray(response.tabs)) throw new Error("Invalid tab response.");
      const useStoredIgnores = ignoreEditRevision === request.ignoreRevision && !request.ignoreSavePending;
      const sameSet = (left, right) => left.size === right.size && [...left].every((value) => right.has(value));
      const samePreferences = !useStoredIgnores || (sameSet(ignoredUrls, ignoreLists.ignoredUrls) &&
        sameSet(ignoredDomains, ignoreLists.ignoredDomains));
      const now = Date.now();
      const unchanged = request.automatic && samePreferences && JSON.stringify(allTabs) === JSON.stringify(response.tabs) &&
        enrichedTabs.every((tab) => tab.ageText === formatAge(now - tab.lastAccessed) &&
          tab.ageBucket === getAgeBucket(now - tab.lastAccessed));
      if (!queuedLoad && request.automatic && !automaticRefreshAllowed()) {
        inventoryDirty = true;
        automaticReconcile = true;
      } else if (!queuedLoad && !unchanged) {
        allTabs = response.tabs;
        // Local edits and saves already pending at request time own preferences.
        if (useStoredIgnores) {
          ignoredUrls = ignoreLists.ignoredUrls;
          ignoredDomains = ignoreLists.ignoredDomains;
        }
        enrichTabs();
        populateDomainFilter();
        render();
        updateIgnoredPanel();
      }
      result = { ok: true };
    } catch (error) {
      if (!queuedLoad && request.shouldReportError()) reportError(`Could not refresh tabs: ${error.message}`);
      result = { ok: false, error: error.message };
    }
    // Explicit requests made during a read require a newer snapshot, not a join.
    request.resolve(queuedLoad ? queuedLoad.promise : result);
  }
  inventoryLoading = false;
  scheduleAutomaticRefresh();
}

function enrichTabs() {
  const now = Date.now();

  // Count tabs per domain
  const domainCounts = Object.create(null);
  for (const tab of allTabs) {
    const d = getDomain(tab.url || "");
    if (d) domainCounts[d] = (domainCounts[d] || 0) + 1;
  }

  // Find duplicates
  const urlCounts = new Map();
  const duplicateRisk = new Map();
  for (const tab of allTabs) {
    const key = normalizeUrl(tab.url);
    if (key !== null) {
      urlCounts.set(key, (urlCounts.get(key) || 0) + 1);
      const risk = duplicateRisk.get(key) || { count: 0, pinned: 0, active: 0 };
      if (isSelectableTab(tab)) {
        risk.count++;
        if (tab.pinned) risk.pinned++;
        if (tab.active) risk.active++;
      }
      duplicateRisk.set(key, risk);
    }
  }

  enrichedTabs = allTabs.map((tab, i) => {
    const domain = getDomain(tab.url || "");
    const lastAccessed = tab.lastAccessed || 0;
    const ageMs = now - lastAccessed;
    const normUrl = normalizeUrl(tab.url || "");
    const risk = duplicateRisk.get(normUrl) || { count: 0, pinned: 0, active: 0 };
    const eligible = isSelectableTab(tab);

    return {
      ...tab,
      index: i + 1,
      domain,
      domainCount: domainCounts[domain] || 0,
      lastAccessed,
      ageMs,
      ageText: formatAge(ageMs),
      ageBucket: getAgeBucket(ageMs),
      isDuplicate: (urlCounts.get(normUrl) || 0) > 1,
      duplicateCount: urlCounts.get(normUrl) || 1,
      duplicateCloseAllCount: risk.count,
      duplicateCloseOtherCount: risk.count - (eligible ? 1 : 0),
      duplicateOtherPinned: risk.pinned - (eligible && tab.pinned ? 1 : 0),
      duplicateOtherActive: risk.active - (eligible && tab.active ? 1 : 0),
      statusList: getStatusList(tab),
    };
  });
}

// --- Scoped duplicate actions ---
let closingDuplicates = false;
let resolveDuplicateConfirmation = null;
let duplicateConfirmationOpener = null;

function confirmAction(message, title = "Confirm duplicate closure", acceptLabel = "Confirm closure") {
  if (resolveDuplicateConfirmation) return Promise.resolve(false);
  const dialog = document.getElementById("duplicateConfirmDialog");
  document.getElementById("duplicateConfirmTitle").textContent = title;
  document.getElementById("duplicateConfirmMessage").textContent = message;
  document.getElementById("duplicateConfirmAccept").textContent = acceptLabel;
  dialog.returnValue = "";
  const element = document.activeElement;
  const row = Array.from(document.getElementById("tab-body").children).find((item) => item.contains(element));
  // A refresh can replace the row while the asynchronous confirmation is open.
  duplicateConfirmationOpener = { element, tabId: row?.dataset.tabId };
  return new Promise((resolve, reject) => {
    resolveDuplicateConfirmation = resolve;
    try {
      dialog.showModal();
      document.getElementById("duplicateConfirmAccept").focus({ preventScroll: true });
    } catch (error) {
      resolveDuplicateConfirmation = null;
      duplicateConfirmationOpener = null;
      reject(error);
    }
  });
}

function duplicateCandidates(plan) {
  return plan.groups.flatMap((group) => group.candidates);
}

function duplicatePreviewText(plan) {
  const candidates = duplicateCandidates(plan);
  const pinned = candidates.filter((tab) => tab.pinned).length;
  const active = candidates.filter((tab) => tab.active).length;
  const scope = plan.mode === "global"
    ? "all accessible windows, including filtered-out and ignored tabs"
    : "loaded inventory across all windows, including filtered-out and ignored tabs";
  const action = plan.mode === "closeAll" ? "Close all copies (including this tab)"
    : plan.mode === "keep" ? "Keep this tab and close other copies" : "Deduplicate all accessible windows";
  const policy = plan.mode === "global"
    ? `${plan.groups.reduce((sum, group) => sum + group.keeperIds.length, 0)} copies retained. Dashboards (loaded or pending), pinned tabs and each window's active tab are protected. All protected copies remain, so duplicates may remain. Otherwise the first browser window/tab-order copy is kept.`
    : "Other pinned and active copies ARE included. Dashboards (loaded or pending) are excluded.";
  return `${action}?\n\nClose ${candidates.length} tabs in ${plan.groups.length} duplicate URL groups.\nScope: ${scope}.\nAt risk: ${pinned} pinned, ${active} active tabs (counts can overlap).\n${policy}\n\nOnly previewed candidates will be attempted; changed tabs are skipped. The browser cannot make the final check and close atomic. Recovery restores the browser's most recent tab/window, not this batch.`;
}

async function runDuplicateAction(mode, clickedId) {
  if (closingDuplicates || closingSelected || closingTabAction) return;
  closingDuplicates = true;
  document.getElementById("dedupAll").setAttribute("aria-disabled", "true");
  document.getElementById("bulkError").textContent = "";
  let attempted = false;
  try {
    const plan = mode === "global" ? (await sendCommand({ type: "previewDuplicates" })).plan
      : buildDuplicatePlan(enrichedTabs, mode, api.runtime.getURL("triage.html"), clickedId);
    const count = duplicateCandidates(plan).length;
    if (count === 0) {
      document.getElementById("duplicateStatus").textContent = "No eligible duplicate copies to close.";
      return;
    }
    // Keep cancellation in the document: Firefox's browser prompt can leak a
    // fresh nonrepeat Escape after dismissal, indistinguishable from a new press.
    if (mode !== "keep" && !await confirmAction(duplicatePreviewText(plan))) return;
    attempted = true;
    const result = await sendCommand({ type: "closeDuplicates", plan });
    const outcomes = [result.closedCount, result.skippedCount, result.failedCount, result.unverifiedCount];
    if (!outcomes.every((count) => Number.isSafeInteger(count) && count >= 0) ||
        outcomes.reduce((sum, count) => sum + count, 0) !== count) {
      throw new Error("Invalid duplicate closure response.");
    }
    const summary = `Closed ${result.closedCount} tabs; ${result.skippedCount} skipped, ${result.failedCount} failed, ${result.unverifiedCount} unverified.`;
    document.getElementById("duplicateStatus").textContent = summary;
    if (result.closedCount > 0) showUndoToast(summary);
    if (result.failedCount || result.unverifiedCount) reportError("Some duplicate closures failed or could not be verified. Refresh before retrying.");
  } catch (error) {
    reportError(`Could not complete duplicate action: ${error.message}`);
  } finally {
    if (attempted) await loadTabs();
    closingDuplicates = false;
    document.getElementById("dedupAll").setAttribute("aria-disabled", "false");
  }
}

// --- Filtering ---

function getCheckedValues(name) {
  return Array.from(document.querySelectorAll(`input[name="${name}"]:checked`))
    .map((el) => el.value);
}

function getStatusFilters() {
  const include = [];
  const exclude = [];
  document.querySelectorAll(".status-toggle").forEach((btn) => {
    const state = btn.dataset.state;
    if (state === "include") include.push(btn.dataset.status);
    if (state === "exclude") exclude.push(btn.dataset.status);
  });
  return { include, exclude };
}

function getFilteredTabs() {
  const search = document.getElementById("search").value.toLowerCase().trim();
  const selectedDomains = getSelectedDomains();
  const ageFilters = getCheckedValues("filterAge");
  const statusFilters = getStatusFilters();

  return enrichedTabs.filter((tab) => {
    // Ignored tabs: hide unless showIgnored is on
    const tabIgnored = isIgnored(tab);
    if (showIgnored) {
      // When showing ignored, ONLY show ignored tabs
      if (!tabIgnored) return false;
    } else {
      if (tabIgnored) return false;
    }

    // Search
    if (search) {
      const haystack = `${tab.title || ""} ${tab.url || ""} ${tab.domain}`.toLowerCase();
      if (fuzzySearch) {
        const terms = search.split(/\s+/);
        if (!terms.every((term) => haystack.includes(term))) return false;
      } else {
        if (!haystack.includes(search)) return false;
      }
    }

    // Domain filter (OR — match any checked domain; empty = all)
    if (selectedDomains.length > 0 && !selectedDomains.includes(tab.domain)) return false;

    // Age filter (OR — match any checked bucket)
    if (ageFilters.length > 0 && !matchesAgeFilter(tab, ageFilters)) return false;

    // Status filter (AND — include must all match, exclude must all not match)
    if ((statusFilters.include.length > 0 || statusFilters.exclude.length > 0) &&
        !matchesStatusFilter(tab, statusFilters)) return false;

    return true;
  });
}

// --- Sorting ---

function sortTabs(tabs) {
  if (currentSort.length === 0) return tabs;

  return [...tabs].sort((a, b) => {
    for (const { key, dir } of currentSort) {
      const mult = dir === "asc" ? 1 : -1;
      let va = a[key];
      let vb = b[key];

      let cmp = 0;
      if (key === "title" || key === "domain") {
        va = (va || "").toLowerCase();
        vb = (vb || "").toLowerCase();
        cmp = va.localeCompare(vb);
      } else if (key === "status") {
        va = a.statusList.join(",");
        vb = b.statusList.join(",");
        cmp = va.localeCompare(vb);
      } else {
        va = va || 0;
        vb = vb || 0;
        cmp = va - vb;
      }

      if (cmp !== 0) return cmp * mult;
    }
    return 0;
  });
}

// --- Grouping ---

function groupTabs(tabs) {
  const groupBy = document.getElementById("groupBy").value;
  if (groupBy === "none") return null;

  const groups = new Map();
  for (const tab of tabs) {
    let key;
    switch (groupBy) {
      case "domain": key = tab.domain || "(no domain)"; break;
      case "window": key = `Window ${tab.windowId}`; break;
      case "age": key = tab.ageBucket; break;
      case "status":
        key = tab.statusList.length > 0 ? tab.statusList.join(", ") : "normal";
        break;
      case "duplicate":
        key = tab.isDuplicate ? "Duplicates" : "Unique";
        break;
      default: key = "other";
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tab);
  }

  // Sort groups by count descending
  return new Map([...groups.entries()].sort((a, b) => b[1].length - a[1].length));
}

// --- Rendering ---

function isSelectableTab(tab) {
  return ![tab.url, tab.pendingUrl].some((url) =>
    (url || "").split(/[?#]/)[0] === api.runtime.getURL("triage.html"));
}

function syncSelection(tabs) {
  const eligibleIds = new Set(tabs.filter(isSelectableTab).map((tab) => tab.id));
  for (const id of selectedTabIds) {
    if (!eligibleIds.has(id)) selectedTabIds.delete(id);
  }
}

function updateSelectionControls(tabs = getFilteredTabs()) {
  const focused = document.activeElement;
  const eligibleCount = tabs.filter(isSelectableTab).length;
  const count = selectedTabIds.size;
  const selectAll = document.getElementById("selectAllTabs");
  selectAll.checked = count > 0 && count === eligibleCount;
  selectAll.indeterminate = count > 0 && count < eligibleCount;
  selectAll.disabled = closingSelected || eligibleCount === 0;
  document.getElementById("selectFiltered").disabled = closingSelected || eligibleCount === 0;
  document.getElementById("clearSelection").disabled = closingSelected || count === 0;
  const closeButton = document.getElementById("closeSelected");
  closeButton.disabled = closingSelected || count === 0;
  closeButton.textContent = closingSelected ? `Closing ${count} tabs...` : `Close selected (${count})`;
  document.getElementById("selectionStatus").textContent = `${count} tabs selected`;
  document.getElementById("exportSelected").disabled = closingSelected ||
    !tabs.some((tab) => selectedTabIds.has(tab.id) && hasExportableUrl(tab));
  document.getElementById("exportAll").disabled = closingSelected || !enrichedTabs.some(hasExportableUrl);
  // Disabling a focused toolbar control can blur it before render restores rows.
  if (focused?.disabled) document.getElementById("search").focus({ preventScroll: true });
}

function hasExportableUrl(tab) {
  return isSelectableTab(tab) && typeof tab.url === "string" && tab.url.trim().length > 0;
}

function exportLinks(selectedOnly) {
  const filtered = getFilteredTabs();
  syncSelection(filtered);
  updateSelectionControls(filtered);
  const tabs = selectedOnly ? filtered.filter((tab) => selectedTabIds.has(tab.id)) : enrichedTabs;
  const urls = sortTabs(tabs).filter(hasExportableUrl).map((tab) => tab.url);
  const status = document.getElementById("exportStatus");
  if (urls.length === 0) {
    status.textContent = "No links to export.";
    return;
  }

  let objectUrl;
  try {
    const blob = new Blob([urls.join("\n") + "\n"], { type: "text/plain;charset=utf-8" });
    objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = `tab-links-${selectedOnly ? "selected" : "all"}.txt`;
    link.hidden = true;
    document.body.appendChild(link);
    try {
      link.click();
    } finally {
      link.remove();
    }
    status.textContent = `Export prepared: ${urls.length} links.`;
  } catch (error) {
    status.textContent = `Could not export links: ${error.message}`;
  } finally {
    // Allow the browser to start the download before releasing the blob.
    if (objectUrl) setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  }
}

function selectFilteredTabs(selected) {
  selectedTabIds = new Set(selected ? getFilteredTabs().filter(isSelectableTab).map((tab) => tab.id) : []);
  document.getElementById("bulkError").textContent = "";
  render();
}

async function closeSelectedTabs() {
  if (closingSelected || closingDuplicates || closingTabAction) return;
  syncSelection(getFilteredTabs());
  const tabIds = [...selectedTabIds];
  if (tabIds.length === 0) {
    render();
    return;
  }

  closingSelected = true;
  document.getElementById("bulkError").textContent = "";
  render();
  try {
    await sendCommand({ type: "closeTabs", tabIds });
    selectedTabIds.clear();
    showUndoToast("Selected-tab close request completed.");
  } catch (error) {
    document.getElementById("bulkError").textContent = `Could not close selected tabs: ${error.message}`;
  } finally {
    await loadTabs();
    closingSelected = false;
    render();
  }
}

function render() {
  const tbody = document.getElementById("tab-body");
  // Capture current focus immediately before rebuilding, not when an async action
  // starts: a pending (or older) action must never steal newer user focus.
  const focused = document.activeElement;
  const focusedRow = Array.from(tbody.children).find((row) => row.contains(focused));
  const focusSelector = ["tab-select", "btn-goto", "btn-close", "btn-dedup", "btn-close-copies", "btn-more"]
    .find((name) => (focused?.className || "").split(" ").includes(name));
  const filtered = getFilteredTabs();
  syncSelection(filtered);
  updateSelectionControls(filtered);
  const sorted = sortTabs(filtered);
  const groups = groupTabs(sorted);

  updateStats(filtered.length, enrichedTabs.length);
  updateSortHeaders();

  tbody.innerHTML = "";

  if (groups) {
    for (const [groupName, tabs] of groups) {
      // Group header
      const headerRow = document.createElement("tr");
      headerRow.className = "group-header";
      const headerTd = document.createElement("td");
      headerTd.colSpan = 10;
      headerTd.textContent = (collapsedGroups.has(groupName) ? "\u25B6" : "\u25BC") + " " + groupName + " ";
      const groupCountSpan = document.createElement("span");
      groupCountSpan.className = "group-count";
      groupCountSpan.textContent = `(${tabs.length} tabs)`;
      headerTd.appendChild(groupCountSpan);
      headerRow.appendChild(headerTd);
      headerRow.addEventListener("click", () => {
        if (collapsedGroups.has(groupName)) {
          collapsedGroups.delete(groupName);
        } else {
          collapsedGroups.add(groupName);
        }
        render();
      });
      tbody.appendChild(headerRow);

      if (!collapsedGroups.has(groupName)) {
        for (const tab of tabs) {
          tbody.appendChild(createTabRow(tab));
        }
      }
    }
  } else {
    for (const tab of sorted) {
      tbody.appendChild(createTabRow(tab));
    }
  }

  if (focusedRow) {
    const row = Array.from(tbody.children).find((item) => item.dataset.tabId === focusedRow.dataset.tabId);
    const action = focusSelector && row?.querySelector(`.${focusSelector}`);
    const target = action && !action.disabled ? action : row?.querySelector(".btn-more");
    // Menu actions are hidden after a rebuild; removed/filtered rows stay gone.
    if (target) target.focus({ preventScroll: true });
    else document.getElementById("search").focus();
  }
  scheduleAutomaticRefresh();
}

function createTabRow(tab) {
  const tr = document.createElement("tr");
  tr.dataset.tabId = String(tab.id);
  if (tab.isDuplicate) tr.className = "duplicate";
  tr.classList.toggle("selected", selectedTabIds.has(tab.id));

  const selectTd = document.createElement("td");
  selectTd.className = "col-select";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "tab-select";
  checkbox.checked = selectedTabIds.has(tab.id);
  checkbox.disabled = closingSelected || !isSelectableTab(tab);
  checkbox.setAttribute("aria-label", `Select ${tab.title || "(untitled)"}`);
  if (!isSelectableTab(tab)) checkbox.title = "The dashboard is excluded from bulk closing";
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) selectedTabIds.add(tab.id);
    else selectedTabIds.delete(tab.id);
    tr.classList.toggle("selected", checkbox.checked);
    updateSelectionControls();
  });
  selectTd.appendChild(checkbox);
  tr.appendChild(selectTd);

  const ageClass = tab.ageMs > 86400000 * 90 ? "very-stale"
    : tab.ageMs > 86400000 * 30 ? "stale" : "";

  const countClass = tab.domainCount >= 20 ? "high"
    : tab.domainCount >= 5 ? "medium" : "low";

  tr.appendChild(createTd("col-index", tab.index));

  // Title cell
  const titleTd = document.createElement("td");
  titleTd.className = "col-title";
  const titleDiv = document.createElement("div");
  titleDiv.className = "tab-title";
  const img = document.createElement("img");
  img.className = "tab-favicon";
  img.alt = "";
  img.src = tab.favIconUrl || "icons/icon-48.png";
  img.onerror = () => {
    img.onerror = null;
    img.src = "icons/icon-48.png";
  };
  titleDiv.appendChild(img);
  const titleInner = document.createElement("div");
  const titleText = document.createElement("div");
  titleText.className = "tab-title-text";
  titleText.title = tab.title || "";
  titleText.textContent = tab.title || "(untitled)";
  titleInner.appendChild(titleText);
  const urlSpan = document.createElement("span");
  urlSpan.className = "tab-url";
  urlSpan.title = tab.url || "";
  urlSpan.textContent = tab.url || "";
  titleInner.appendChild(urlSpan);
  titleDiv.appendChild(titleInner);
  titleTd.appendChild(titleDiv);
  tr.appendChild(titleTd);

  // Domain cell
  const domainTd = document.createElement("td");
  domainTd.className = "col-domain";
  const domainSpan = document.createElement("span");
  domainSpan.className = "tab-domain";
  domainSpan.textContent = tab.domain;
  domainTd.appendChild(domainSpan);
  tr.appendChild(domainTd);

  // Count cell
  const countTd = document.createElement("td");
  countTd.className = "col-count";
  const countSpan = document.createElement("span");
  countSpan.className = "domain-count " + countClass;
  countSpan.textContent = tab.domainCount;
  countTd.appendChild(countSpan);
  tr.appendChild(countTd);

  // Accessed cell
  tr.appendChild(createTd("col-accessed", formatDate(tab.lastAccessed)));

  // Age cell
  const ageTd = document.createElement("td");
  ageTd.className = "col-age";
  const ageSpan = document.createElement("span");
  ageSpan.className = "age-text " + ageClass;
  ageSpan.textContent = tab.ageText;
  ageTd.appendChild(ageSpan);
  tr.appendChild(ageTd);

  // Window cell
  tr.appendChild(createTd("col-window", tab.windowId));

  // Status cell
  const statusTd = document.createElement("td");
  statusTd.className = "col-status";
  const badgesDiv = document.createElement("div");
  badgesDiv.className = "status-badges";
  for (const s of tab.statusList) {
    const badge = document.createElement("span");
    badge.className = "badge badge-" + s;
    badge.textContent = s;
    badgesDiv.appendChild(badge);
  }
  if (tab.isDuplicate) {
    const dupBadge = document.createElement("span");
    dupBadge.className = "badge badge-duplicate";
    dupBadge.textContent = "dup \u00D7" + tab.duplicateCount;
    badgesDiv.appendChild(dupBadge);
  }
  statusTd.appendChild(badgesDiv);
  tr.appendChild(statusTd);

  // Actions cell
  const actionsTd = document.createElement("td");
  actionsTd.className = "col-actions";
  const actionsDiv = document.createElement("div");
  actionsDiv.className = "action-buttons";
  const goBtn = document.createElement("button");
  goBtn.className = "btn-goto";
  goBtn.dataset.tabId = tab.id;
  goBtn.dataset.windowId = tab.windowId;
  goBtn.title = "Switch to tab";
  goBtn.textContent = "Go";
  actionsDiv.appendChild(goBtn);
  if (tab.isDuplicate) {
    const dedupBtn = document.createElement("button");
    dedupBtn.className = "btn-dedup";
    dedupBtn.dataset.tabId = tab.id;
    dedupBtn.title = `Keep this tab; close ${tab.duplicateCloseOtherCount} other copies in loaded inventory across all windows, including filtered-out and ignored tabs. Includes ${tab.duplicateOtherPinned} pinned and ${tab.duplicateOtherActive} active copies. Dashboards are excluded.`;
    dedupBtn.textContent = `Keep this; close ${tab.duplicateCloseOtherCount}`;
    actionsDiv.appendChild(dedupBtn);
    const closeCopiesBtn = document.createElement("button");
    closeCopiesBtn.className = "btn-close-copies";
    closeCopiesBtn.textContent = `Close all copies (${tab.duplicateCloseAllCount})`;
    closeCopiesBtn.title = "Preview closing all loaded copies, including this tab, across all windows and filters";
    closeCopiesBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      return runDuplicateAction("closeAll", tab.id);
    });
    actionsDiv.appendChild(closeCopiesBtn);
  }
  const moreDropdown = document.createElement("div");
  moreDropdown.className = "more-dropdown";
  const moreBtn = document.createElement("button");
  moreBtn.className = "btn-more";
  moreBtn.title = "More actions";
  moreBtn.textContent = "\u22EE";
  moreDropdown.appendChild(moreBtn);
  const moreMenu = document.createElement("div");
  moreMenu.className = "more-menu";
  const filterDomainBtn = document.createElement("button");
  filterDomainBtn.className = "btn-filter-domain";
  filterDomainBtn.textContent = tab.domain ? `Filter ${tab.domain}` : "Filter domain";
  filterDomainBtn.disabled = !tab.domain;
  filterDomainBtn.title = tab.domain ? "Show only this domain using the domain filter" : "This tab has no domain to filter";
  filterDomainBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!tab.domain) return;
    const options = Array.from(document.querySelectorAll('input[name="filterDomain"]'));
    if (!options.some((checkbox) => checkbox.value === tab.domain)) return;
    options.forEach((checkbox) => {
      checkbox.checked = checkbox.value === tab.domain;
    });
    moreMenu.classList.remove("open");
    document.getElementById("domainDropdown").classList.remove("open");
    updateDomainButtonLabel();
    render();
    document.getElementById("domainDropdownBtn").focus();
  });
  moreMenu.appendChild(filterDomainBtn);
  const discardBtn = document.createElement("button");
  discardBtn.className = "btn-discard";
  discardBtn.textContent = "Discard tab";
  discardBtn.disabled = !!(tab.active || tab.discarded);
  discardBtn.title = tab.active ? "The active tab cannot be discarded."
    : tab.discarded ? "This tab is already discarded." : "Discard inactive tab to free memory";
  moreMenu.appendChild(discardBtn);
  const ignoreUrlBtn = document.createElement("button");
  ignoreUrlBtn.className = "btn-ignore-url";
  ignoreUrlBtn.textContent = "Ignore URL";
  moreMenu.appendChild(ignoreUrlBtn);
  const ignoreDomainBtn = document.createElement("button");
  ignoreDomainBtn.className = "btn-ignore-domain";
  ignoreDomainBtn.textContent = "Ignore " + tab.domain;
  moreMenu.appendChild(ignoreDomainBtn);
  moreDropdown.appendChild(moreMenu);
  actionsDiv.appendChild(moreDropdown);
  const closeBtn = document.createElement("button");
  closeBtn.className = "btn-close";
  closeBtn.dataset.tabId = tab.id;
  closeBtn.title = "Close tab";
  closeBtn.textContent = "\u2715";
  actionsDiv.appendChild(closeBtn);
  actionsTd.appendChild(actionsDiv);
  tr.appendChild(actionsTd);

  // Go button
  tr.querySelector(".btn-goto").addEventListener("click", async (e) => {
    e.stopPropagation();
    await runTabAction({
      type: "goToTab",
      tabId: tab.id,
      windowId: tab.windowId,
    });
  });

  // Close button
  tr.querySelector(".btn-close").addEventListener("click", async (e) => {
    e.stopPropagation();
    await runTabAction({ type: "closeTab", tabId: tab.id }, `Closed "${tab.title}"`);
  });

  // Dedup button
  const dedupBtn = tr.querySelector(".btn-dedup");
  if (dedupBtn) {
    dedupBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await runDuplicateAction("keep", tab.id);
    });
  }

  // Ignore URL button
  tr.querySelector(".btn-ignore-url").addEventListener("click", (e) => {
    e.stopPropagation();
    ignoreUrl(tab.url);
  });

  // Ignore domain button
  tr.querySelector(".btn-ignore-domain").addEventListener("click", (e) => {
    e.stopPropagation();
    ignoreDomain(tab.domain);
  });

  // Discard tab button
  tr.querySelector(".btn-discard").addEventListener("click", async (e) => {
    e.stopPropagation();
    await runTabAction({ type: "discardTab", tabId: tab.id });
  });

  // More menu toggle
  const moreBtnEl = tr.querySelector(".btn-more");
  const moreMenuEl = tr.querySelector(".more-menu");
  moreBtnEl.addEventListener("click", (e) => {
    e.stopPropagation();
    // Close any other open menus
    document.querySelectorAll(".more-menu.open").forEach((m) => {
      if (m !== moreMenuEl) m.classList.remove("open");
    });
    moreMenuEl.classList.toggle("open");
    scheduleAutomaticRefresh();
    if (!moreMenuEl.classList.contains("open")) return;
    // Flip and clamp within the viewport above any visible recovery notice.
    const rect = moreBtnEl.getBoundingClientRect();
    const margin = 8;
    const toast = document.getElementById("undo-toast");
    const bottom = toast.hidden ? window.innerHeight - margin
      : Math.min(window.innerHeight - margin, toast.getBoundingClientRect().top - margin);
    moreMenuEl.style.minWidth = "0px";
    moreMenuEl.style.maxWidth = `${Math.max(0, window.innerWidth - 2 * margin)}px`;
    moreMenuEl.style.maxHeight = `${Math.max(0, bottom - margin)}px`;
    moreMenuEl.style.overflow = "auto";
    const menuRect = moreMenuEl.getBoundingClientRect();
    const top = rect.bottom + 4 + menuRect.height > bottom
      ? rect.top - menuRect.height - 4 : rect.bottom + 4;
    moreMenuEl.style.top = `${Math.max(margin, Math.min(top, bottom - menuRect.height))}px`;
    moreMenuEl.style.left = `${Math.max(margin, Math.min(rect.right - menuRect.width, window.innerWidth - menuRect.width - margin))}px`;
    moreMenuEl.style.transform = "none";
  });

  return tr;
}

function updateStats(shown, total) {
  const dupes = enrichedTabs.filter((t) => t.isDuplicate).length;
  const domains = new Set(enrichedTabs.map((t) => t.domain).filter(Boolean)).size;
  const windows = new Set(enrichedTabs.map((t) => t.windowId)).size;
  const ignored = enrichedTabs.filter((t) => isIgnored(t)).length;
  let text = `${shown}/${total} tabs | ${domains} domains | ${windows} windows | ${dupes} duplicates`;
  if (ignored > 0) text += ` | ${ignored} ignored`;
  document.getElementById("stats").textContent = text;
}

function updateSortHeaders() {
  document.querySelectorAll("th.sortable").forEach((th) => {
    th.classList.remove("sort-asc", "sort-desc");
    th.removeAttribute("data-sort-order");
    const idx = currentSort.findIndex((s) => s.key === th.dataset.sort);
    if (idx !== -1) {
      th.classList.add(currentSort[idx].dir === "asc" ? "sort-asc" : "sort-desc");
      if (currentSort.length > 1) {
        th.setAttribute("data-sort-order", idx + 1);
      }
    }
  });
}

function populateDomainFilter() {
  const selectedDomains = new Set(getSelectedDomains());
  const focusedDomain = Array.from(document.querySelectorAll('input[name="filterDomain"]'))
    .find((input) => input === document.activeElement)?.value;
  const query = document.getElementById("domainSearch").value.toLowerCase();
  const domainCounts = Object.create(null);
  for (const tab of enrichedTabs) {
    if (tab.domain) {
      domainCounts[tab.domain] = (domainCounts[tab.domain] || 0) + 1;
    }
  }

  // A selected domain with no current tabs must still constrain the inventory.
  for (const domain of selectedDomains) {
    if (!Object.hasOwn(domainCounts, domain)) domainCounts[domain] = 0;
  }
  const sorted = Object.entries(domainCounts).sort((a, b) => b[1] - a[1]);
  const list = document.getElementById("domainList");
  list.innerHTML = "";

  for (const [domain, count] of sorted) {
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "filterDomain";
    checkbox.value = domain;
    checkbox.checked = selectedDomains.has(domain);
    label.style.display = domain.toLowerCase().includes(query) ? "" : "none";
    label.appendChild(checkbox);
    const nameSpan = document.createElement("span");
    nameSpan.textContent = domain;
    label.appendChild(nameSpan);
    const countSpan = document.createElement("span");
    countSpan.className = "domain-item-count";
    countSpan.textContent = count;
    label.appendChild(countSpan);
    label.querySelector("input").addEventListener("change", () => {
      updateDomainButtonLabel();
      render();
    });
    list.appendChild(label);
    if (domain === focusedDomain && label.style.display !== "none") checkbox.focus({ preventScroll: true });
  }

  if (focusedDomain !== undefined && !list.contains(document.activeElement)) {
    document.getElementById("domainSearch").focus({ preventScroll: true });
  }
  updateDomainButtonLabel();
}

function getSelectedDomains() {
  return Array.from(document.querySelectorAll('input[name="filterDomain"]:checked'))
    .map((el) => el.value);
}

function updateDomainButtonLabel() {
  const selected = getSelectedDomains();
  const btn = document.getElementById("domainDropdownBtn");
  const total = document.querySelectorAll('input[name="filterDomain"]').length;
  if (selected.length === 0) {
    btn.textContent = `All domains (${total})`;
  } else if (selected.length === 1) {
    btn.textContent = selected[0];
  } else {
    btn.textContent = `${selected.length} domains selected`;
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function createTd(className, text) {
  const td = document.createElement("td");
  td.className = className;
  td.textContent = text;
  return td;
}

// --- Ignore lists ---

async function loadIgnoreLists() {
  const result = await api.storage.local.get(["ignoredUrls", "ignoredDomains"]);
  return {
    ignoredUrls: new Set(result.ignoredUrls || []),
    ignoredDomains: new Set(result.ignoredDomains || []),
  };
}

async function saveIgnoreLists() {
  pendingIgnoreSaves++;
  try {
    await api.storage.local.set({
      ignoredUrls: [...ignoredUrls],
      ignoredDomains: [...ignoredDomains],
    });
  } finally {
    pendingIgnoreSaves--;
  }
}

async function ignoreUrl(url) {
  const norm = normalizeIgnoredUrl(url);
  if (!norm) return;
  ignoreEditRevision++;
  ignoredUrls.add(norm);
  await saveIgnoreLists();
  render();
  updateIgnoredPanel();
}

async function ignoreDomain(domain) {
  if (!domain) return;
  ignoreEditRevision++;
  ignoredDomains.add(domain);
  await saveIgnoreLists();
  render();
  updateIgnoredPanel();
}

async function unignoreUrl(url) {
  ignoreEditRevision++;
  ignoredUrls.delete(url);
  await saveIgnoreLists();
  render();
  updateIgnoredPanel();
}

async function unignoreDomain(domain) {
  ignoreEditRevision++;
  ignoredDomains.delete(domain);
  await saveIgnoreLists();
  render();
  updateIgnoredPanel();
}

async function resetAllIgnored() {
  ignoreEditRevision++;
  ignoredUrls.clear();
  ignoredDomains.clear();
  await saveIgnoreLists();
  render();
  updateIgnoredPanel();
}

function isIgnored(tab) {
  if (ignoredDomains.has(tab.domain)) return true;
  if (ignoredUrls.has(normalizeIgnoredUrl(tab.url || ""))) return true;
  return false;
}

function updateIgnoredPanel() {
  const urlList = document.getElementById("ignoredUrlList");
  const domainList = document.getElementById("ignoredDomainList");
  const count = document.getElementById("ignoredCount");
  const focusedList = [urlList, domainList].find((list) => list.contains(document.activeElement));
  const focusedValue = focusedList && Array.from(focusedList.children)
    .find((item) => item.contains(document.activeElement))?.dataset.ignoreValue;

  count.textContent = `${ignoredUrls.size} URLs, ${ignoredDomains.size} domains`;

  urlList.innerHTML = "";
  for (const url of [...ignoredUrls].sort()) {
    const li = document.createElement("li");
    li.dataset.ignoreValue = url;
    const textSpan = document.createElement("span");
    textSpan.className = "ignored-item-text";
    textSpan.title = url;
    textSpan.textContent = url;
    li.appendChild(textSpan);
    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-unignore";
    removeBtn.title = "Remove from ignore list";
    removeBtn.textContent = "\u2715";
    removeBtn.addEventListener("click", () => unignoreUrl(url));
    li.appendChild(removeBtn);
    urlList.appendChild(li);
  }

  domainList.innerHTML = "";
  for (const domain of [...ignoredDomains].sort()) {
    const li = document.createElement("li");
    li.dataset.ignoreValue = domain;
    const textSpan = document.createElement("span");
    textSpan.className = "ignored-item-text";
    textSpan.textContent = domain;
    li.appendChild(textSpan);
    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-unignore";
    removeBtn.title = "Remove from ignore list";
    removeBtn.textContent = "\u2715";
    removeBtn.addEventListener("click", () => unignoreDomain(domain));
    li.appendChild(removeBtn);
    domainList.appendChild(li);
  }
  if (focusedList) {
    const replacement = Array.from(focusedList.children).find((item) => item.dataset.ignoreValue === focusedValue);
    (replacement?.querySelector(".btn-unignore") || document.getElementById("toggleIgnoredPanel"))
      .focus({ preventScroll: true });
  }
}

// --- Event listeners ---

document.getElementById("dedupAll").addEventListener("click", () => runDuplicateAction("global"));

const duplicateConfirmDialog = document.getElementById("duplicateConfirmDialog");
document.getElementById("duplicateConfirmCancel").addEventListener("click", () => duplicateConfirmDialog.close("cancel"));
document.getElementById("duplicateConfirmAccept").addEventListener("click", () => duplicateConfirmDialog.close("confirm"));
duplicateConfirmDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  duplicateConfirmDialog.close("cancel");
});
duplicateConfirmDialog.addEventListener("close", () => {
  const resolve = resolveDuplicateConfirmation;
  if (!resolve) return;
  const accepted = duplicateConfirmDialog.returnValue === "confirm";
  resolveDuplicateConfirmation = null;
  const opener = duplicateConfirmationOpener;
  duplicateConfirmationOpener = null;
  const focusTarget = opener?.tabId === undefined ? opener?.element
    : Array.from(document.getElementById("tab-body").children)
      .find((row) => row.dataset.tabId === opener.tabId)?.querySelector(".btn-close-copies");
  (focusTarget || document.getElementById("search")).focus({ preventScroll: true });
  resolve(accepted);
  scheduleAutomaticRefresh();
});

// Native dialog supplies modal focus containment in supported Firefox/Chrome.
const helpDialog = document.getElementById("helpDialog");
document.getElementById("helpAbout").addEventListener("click", () => {
  let version = "unknown";
  let browserContext = "unknown";
  try {
    const manifest = api.runtime.getManifest?.();
    const installedVersion = manifest?.version;
    if (typeof installedVersion === "string" && installedVersion.trim()) version = installedVersion;
    // Identify the package, not the API alias: Chromium may expose both aliases.
    if (manifest?.browser_specific_settings?.gecko) browserContext = "Firefox";
    else if (typeof manifest?.background?.service_worker === "string" && manifest.background.service_worker.trim()) browserContext = "Chrome";
  } catch {
    // Help remains available if runtime metadata cannot be read.
  }
  document.getElementById("helpVersion").textContent = `Installed version: ${version}`;
  document.getElementById("helpBrowser").textContent = `Browser context: ${browserContext}`;
  helpDialog.showModal();
  document.getElementById("helpClose").focus();
});
document.getElementById("helpClose").addEventListener("click", () => helpDialog.close());
helpDialog.addEventListener("close", () => {
  document.getElementById("helpAbout").focus({ preventScroll: true });
  scheduleAutomaticRefresh();
});

document.getElementById("selectFiltered").addEventListener("click", () => selectFilteredTabs(true));
document.getElementById("clearSelection").addEventListener("click", () => selectFilteredTabs(false));
document.getElementById("selectAllTabs").addEventListener("change", (e) => selectFilteredTabs(e.target.checked));
document.getElementById("closeSelected").addEventListener("click", closeSelectedTabs);
document.getElementById("exportSelected").addEventListener("click", () => exportLinks(true));
document.getElementById("exportAll").addEventListener("click", () => exportLinks(false));

// Sort on header click — default direction → opposite direction → off
// Multiple columns supported; click adds to sort, existing column cycles
document.querySelector("thead").addEventListener("click", (e) => {
  const th = e.target.closest("th.sortable");
  if (!th) return;
  const key = th.dataset.sort;
  const defaultDir = key === "title" || key === "domain" ? "asc" : "desc";

  const existingIdx = currentSort.findIndex((s) => s.key === key);
  if (existingIdx === -1) {
    // New column: add with default direction
    currentSort.push({ key, dir: defaultDir });
  } else {
    const existing = currentSort[existingIdx];
    if (existing.dir === defaultDir) {
      existing.dir = defaultDir === "asc" ? "desc" : "asc";
    } else {
      // Both directions visited; remove only this column's sort.
      currentSort.splice(existingIdx, 1);
    }
  }
  render();
});

// Search with debounce
let searchTimeout;
document.getElementById("search").addEventListener("input", () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(render, 200);
});

// Filters
document.getElementById("groupBy").addEventListener("change", () => {
  collapsedGroups.clear();
  render();
});

// Domain dropdown toggle
const domainBtn = document.getElementById("domainDropdownBtn");
const domainPanel = document.getElementById("domainDropdown");

domainBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  domainPanel.classList.toggle("open");
  scheduleAutomaticRefresh();
  if (domainPanel.classList.contains("open")) {
    setTimeout(() => document.getElementById("domainSearch").focus(), 0);
  }
});

// Close dropdown when clicking outside
document.addEventListener("click", (e) => {
  if (!e.target.closest(".domain-filter")) {
    domainPanel.classList.remove("open");
  }
  if (!e.target.closest(".more-dropdown")) {
    document.querySelectorAll(".more-menu.open").forEach((m) => m.classList.remove("open"));
  }
  scheduleAutomaticRefresh();
});

// Fixed row menus must not remain beside a different row after the page moves.
function closeRowMenus() {
  document.querySelectorAll(".more-menu.open").forEach((menu) => {
    if (document.activeElement && menu.contains(document.activeElement)) {
      menu.parentElement.querySelector(".btn-more").focus({ preventScroll: true });
    }
    menu.classList.remove("open");
  });
  scheduleAutomaticRefresh();
}

document.addEventListener("scroll", (event) => {
  if (!event.target.closest?.(".more-menu")) closeRowMenus();
}, true);
window.addEventListener("resize", closeRowMenus);

// Domain search within dropdown
document.getElementById("domainSearch").addEventListener("input", (e) => {
  const query = e.target.value.toLowerCase();
  document.querySelectorAll("#domainList label").forEach((label) => {
    const domain = label.querySelector("input").value.toLowerCase();
    label.style.display = domain.includes(query) ? "" : "none";
  });
});

// Select All / None
document.getElementById("domainSelectAll").addEventListener("click", () => {
  document.querySelectorAll('#domainList label:not([style*="display: none"]) input').forEach((cb) => {
    cb.checked = true;
  });
  updateDomainButtonLabel();
  render();
});

document.getElementById("domainSelectNone").addEventListener("click", () => {
  document.querySelectorAll('input[name="filterDomain"]').forEach((cb) => {
    cb.checked = false;
  });
  updateDomainButtonLabel();
  render();
});

// Checkbox filters
document.querySelectorAll('input[name="filterAge"]').forEach((el) => {
  el.addEventListener("change", render);
});
document.querySelectorAll(".status-toggle").forEach((btn) => {
  btn.addEventListener("click", () => {
    const states = ["off", "include", "exclude"];
    const current = states.indexOf(btn.dataset.state);
    btn.dataset.state = states[(current + 1) % 3];
    render();
  });
});

// Show ignored toggle
document.getElementById("showIgnored").addEventListener("change", (e) => {
  showIgnored = e.target.checked;
  render();
});

// Fuzzy search toggle
document.getElementById("fuzzyToggle").addEventListener("click", () => {
  fuzzySearch = !fuzzySearch;
  document.getElementById("fuzzyToggle").classList.toggle("active", fuzzySearch);
  document.getElementById("fuzzyToggle").setAttribute("aria-pressed", String(fuzzySearch));
  document.getElementById("search").placeholder = fuzzySearch
    ? "Fuzzy search (match all words in any order)..."
    : "Search tabs (title, URL, domain)...";
  render();
});

// Ignored panel toggle
document.getElementById("toggleIgnoredPanel").addEventListener("click", () => {
  const panel = document.getElementById("ignoredPanel");
  panel.classList.toggle("open");
});

// Reset all ignored
document.getElementById("resetIgnored").addEventListener("click", async () => {
  if (await confirmAction("Remove all ignored URLs and domains?", "Reset ignored lists", "Reset ignored lists")) {
    await resetAllIgnored();
  }
});

// Favicon size slider
const faviconSlider = document.getElementById("faviconSize");
const faviconLabel = document.getElementById("faviconSizeLabel");

function applyFaviconSize(size) {
  faviconSlider.value = size;
  faviconLabel.textContent = `${size}px`;
  document.documentElement.style.setProperty("--favicon-size", `${size}px`);
}

faviconSlider.addEventListener("input", async () => {
  const size = faviconSlider.value;
  applyFaviconSize(size);
  try {
    await api.storage.local.set({ faviconSize: Number(size) });
  } catch (error) {
    reportError(`Could not save favicon size: ${error.message}`);
  }
});

// Restore saved favicon size
api.storage.local.get("faviconSize").then((result) => {
  if (result.faviconSize) applyFaviconSize(result.faviconSize);
}).catch((error) => reportError(`Could not load favicon size: ${error.message}`));

// Refresh
document.getElementById("refresh").addEventListener("click", refreshTabs);

// Escape dismisses Help before the ordinary search shortcut.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    // Holding the dismissal key must not become a second search-clear action.
    if (e.repeat) return;
    if (duplicateConfirmDialog.open) {
      e.preventDefault();
      duplicateConfirmDialog.close("cancel");
      return;
    }
    if (helpDialog.open) {
      e.preventDefault();
      helpDialog.close();
      return;
    }
    const search = document.getElementById("search");
    if (search.value) {
      search.value = "";
      render();
    }
  }
});

// --- Most-recent session recovery ---

function updateUndoToastSpace() {
  // Notification replacement/wrapping can invalidate an already open menu.
  // Reuse focus-safe dismissal; never move focus from unrelated controls.
  closeRowMenus();
  const toast = document.getElementById("undo-toast");
  const style = getComputedStyle(toast);
  // Keep the final row above the fixed notice, including wrapped/zoomed layouts.
  const height = toast.hidden ? 0 : toast.offsetHeight + parseFloat(style.bottom) + parseFloat(style.rowGap);
  document.getElementById("undo-toast-status").style.height = `${height}px`;
}

const undoToastObserver = new ResizeObserver(updateUndoToastSpace);
undoToastObserver.observe(document.getElementById("undo-toast"));

function showUndoToast(message) {
  const toast = document.getElementById("undo-toast");
  const msgEl = document.getElementById("undo-toast-msg");
  const btn = document.getElementById("undo-toast-btn");

  toast.hidden = false;
  msgEl.textContent = message;

  // Replace button to clear old listeners, preserving only its current focus.
  const hadFocus = document.activeElement === btn;
  const newBtn = btn.cloneNode(true);
  newBtn.disabled = false;
  newBtn.setAttribute("aria-disabled", "false");
  btn.replaceWith(newBtn);
  if (hadFocus) newBtn.focus({ preventScroll: true });
  newBtn.textContent = "Restore most recently closed tab/window";
  newBtn.title = "The browser chooses the session; this is not an undo of this batch.";
  updateUndoToastSpace();

  let restoring = false;
  newBtn.addEventListener("click", async () => {
    if (restoring) return;
    restoring = true;
    // Native disabled can blur a focused button before the request settles.
    newBtn.setAttribute("aria-disabled", "true");
    document.getElementById("bulkError").textContent = "";
    try {
      await sendCommand({ type: "restoreTab" });
      if (document.getElementById("undo-toast-btn") === newBtn) {
        if (document.activeElement === newBtn) {
          document.getElementById("search").focus();
        }
        toast.hidden = true;
        updateUndoToastSpace();
        newBtn.disabled = true;
      }
    } catch (error) {
      if (document.getElementById("undo-toast-btn") === newBtn) {
        reportError(`Could not restore most recent session: ${error.message}`);
        restoring = false;
        newBtn.setAttribute("aria-disabled", "false");
      }
    } finally {
      await loadTabs(() => document.getElementById("undo-toast-btn") === newBtn);
    }
  });
}

// --- Live inventory ---
let automaticTimer;
let inventoryDirty = false;
let automaticReconcile = false;
let liveRefresh = { mode: "instant", seconds: 5 };
let liveRefreshEdited = false;
let liveRefreshReady = false;

function validLiveRefreshSettings(settings) {
  return settings && ["instant", "timed", "off"].includes(settings.mode) &&
    Number.isInteger(settings.seconds) && settings.seconds >= 1 && settings.seconds <= 60;
}

function applyLiveRefreshSettings(settings) {
  if (!validLiveRefreshSettings(settings)) return;
  liveRefresh = { mode: settings.mode, seconds: settings.seconds };
  document.getElementById("liveRefreshMode").value = settings.mode;
  document.getElementById("liveRefreshSeconds").value = settings.seconds;
  document.getElementById("liveRefreshInterval").hidden = settings.mode !== "timed";
  clearTimeout(automaticTimer);
  automaticTimer = undefined;
  scheduleAutomaticRefresh();
}

async function saveLiveRefreshSettings() {
  liveRefreshEdited = true;
  liveRefreshReady = true;
  const interval = document.getElementById("liveRefreshSeconds");
  const mode = document.getElementById("liveRefreshMode").value;
  const settings = { mode, seconds: mode === "timed" ? Number(interval.value) : liveRefresh.seconds };
  if (!validLiveRefreshSettings(settings)) {
    interval.setAttribute("aria-invalid", "true");
    return;
  }
  interval.removeAttribute("aria-invalid");
  applyLiveRefreshSettings(settings);
  try {
    await api.storage.local.set({ liveRefresh });
  } catch (error) {
    reportError(`Could not save live inventory settings: ${error.message}`);
  }
}

function automaticRefreshAllowed() {
  return !document.hidden && liveRefresh.mode !== "off" &&
    !duplicateConfirmDialog.open && !helpDialog.open &&
    !domainPanel.classList.contains("open") && document.querySelectorAll(".more-menu.open").length === 0;
}

function scheduleAutomaticRefresh() {
  if (liveRefresh.mode === "instant" && !inventoryDirty) return;
  if (!liveRefreshReady) return;
  if (!automaticRefreshAllowed() || inventoryLoading || automaticTimer !== undefined) return;
  automaticTimer = setTimeout(() => {
    automaticTimer = undefined;
    if (!automaticRefreshAllowed()) {
      inventoryDirty = true;
      automaticReconcile = true;
      return;
    }
    if (inventoryLoading) return;
    inventoryDirty = false;
    automaticReconcile = false;
    loadTabs(() => false, true);
  }, liveRefresh.mode === "timed" && !automaticReconcile ? liveRefresh.seconds * 1000 : 150);
}

function invalidateInventory() {
  inventoryDirty = true;
  scheduleAutomaticRefresh();
}

function initializeLiveRefresh() {
  document.getElementById("liveRefreshMode").addEventListener("change", saveLiveRefreshSettings);
  document.getElementById("liveRefreshSeconds").addEventListener("change", saveLiveRefreshSettings);
  api.storage.local.get("liveRefresh").then((result) => {
    liveRefreshReady = true;
    if (!liveRefreshEdited && result.liveRefresh) applyLiveRefreshSettings(result.liveRefresh);
    scheduleAutomaticRefresh();
  }).catch((error) => {
    liveRefreshReady = true;
    reportError(`Could not load live inventory settings: ${error.message}`);
    scheduleAutomaticRefresh();
  });

  document.addEventListener("visibilitychange", () => {
    clearTimeout(automaticTimer);
    automaticTimer = undefined;
    inventoryDirty = true;
    automaticReconcile = true;
    scheduleAutomaticRefresh();
  });

  for (const name of ["onRemoved", "onCreated", "onUpdated", "onMoved", "onAttached", "onDetached", "onActivated", "onReplaced"]) {
    api.tabs[name]?.addListener(name === "onUpdated" ? (tabId, changes) => {
      if (["url", "pendingUrl", "title", "favIconUrl", "pinned", "audible", "mutedInfo", "discarded", "active", "lastAccessed", "status"]
        .some((key) => Object.hasOwn(changes, key))) invalidateInventory();
    } : invalidateInventory);
  }
}

// --- Init ---
initializeLiveRefresh();
// Resolve this page's identity before initial load so broadcasts can be ignored
// synchronously by every non-target page without claiming a response channel.
api.tabs.getCurrent().then((tab) => {
  if (Number.isSafeInteger(tab?.id) && tab.id >= 0) {
    api.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type !== "refreshDashboard" || message.tabId !== tab.id) return false;
      refreshTabs().then(sendResponse).catch((error) => {
        reportError(`Could not acknowledge dashboard refresh: ${error.message}`);
      });
      return true;
    });
  }
  return refreshTabs();
}).catch(async (error) => {
  // Identity failure must not block the ordinary inventory/manual refresh path.
  await refreshTabs();
  reportError(`Could not initialize dashboard refresh: ${error.message}`);
});
