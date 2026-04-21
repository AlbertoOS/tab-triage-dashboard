// Tab Triage — triage page logic

let allTabs = [];
let enrichedTabs = [];
let currentSort = []; // Array of { key, dir } for multi-column sort
let collapsedGroups = new Set();
let ignoredUrls = new Set();
let ignoredDomains = new Set();
let showIgnored = false;

// --- Data ---

async function loadTabs() {
  await loadIgnoreLists();
  const response = await browser.runtime.sendMessage({ type: "getTabs" });
  allTabs = response.tabs;
  enrichTabs();
  populateDomainFilter();
  render();
  updateIgnoredPanel();
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return (u.origin + u.pathname + u.search).replace(/\/+$/, "");
  } catch {
    return url;
  }
}

function enrichTabs() {
  const now = Date.now();

  // Count tabs per domain
  const domainCounts = {};
  for (const tab of allTabs) {
    const d = getDomain(tab.url || "");
    if (d) domainCounts[d] = (domainCounts[d] || 0) + 1;
  }

  // Find duplicates
  const urlCounts = {};
  for (const tab of allTabs) {
    if (!tab.url || tab.url.startsWith("about:")) continue;
    const key = normalizeUrl(tab.url);
    urlCounts[key] = (urlCounts[key] || 0) + 1;
  }

  enrichedTabs = allTabs.map((tab, i) => {
    const domain = getDomain(tab.url || "");
    const lastAccessed = tab.lastAccessed || 0;
    const ageMs = now - lastAccessed;
    const normUrl = normalizeUrl(tab.url || "");

    return {
      ...tab,
      index: i + 1,
      domain,
      domainCount: domainCounts[domain] || 0,
      lastAccessed,
      ageMs,
      ageText: formatAge(ageMs),
      ageBucket: getAgeBucket(ageMs),
      isDuplicate: (urlCounts[normUrl] || 0) > 1,
      duplicateCount: urlCounts[normUrl] || 1,
      statusList: getStatusList(tab),
    };
  });
}

function formatAge(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function getAgeBucket(ms) {
  const hr = ms / 3600000;
  if (hr < 1) return "< 1 hour";
  if (hr < 24) return "< 24 hours";
  const days = hr / 24;
  if (days < 7) return "< 7 days";
  if (days < 30) return "< 30 days";
  if (days < 90) return "30-90 days";
  if (days < 180) return "90-180 days";
  if (days < 365) return "180-365 days";
  return "365+ days";
}

function getStatusList(tab) {
  const s = [];
  if (tab.pinned) s.push("pinned");
  if (tab.audible) s.push("audible");
  if (tab.mutedInfo && tab.mutedInfo.muted) s.push("muted");
  if (tab.discarded) s.push("discarded");
  if (tab.active) s.push("active");
  return s;
}

function formatDate(ts) {
  if (!ts) return "\u2014";
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

function matchesAgeFilter(tab, ageFilters) {
  // OR logic: tab matches if it fits ANY checked age bucket
  const hr = tab.ageMs / 3600000;
  const days = hr / 24;
  for (const f of ageFilters) {
    switch (f) {
      case "1h": if (hr < 1) return true; break;
      case "24h": if (hr < 24) return true; break;
      case "7d": if (days < 7) return true; break;
      case "30d": if (days < 30) return true; break;
      case "30d+": if (days >= 30) return true; break;
      case "90d+": if (days >= 90) return true; break;
      case "180d+": if (days >= 180) return true; break;
      case "365d+": if (days >= 365) return true; break;
    }
  }
  return false;
}

function matchesStatusFilter(tab, statusFilters) {
  const { include, exclude } = statusFilters;

  function hasStatus(status) {
    switch (status) {
      case "pinned": return !!tab.pinned;
      case "audible": return !!tab.audible;
      case "muted": return !!(tab.mutedInfo && tab.mutedInfo.muted);
      case "discarded": return !!tab.discarded;
      case "active": return !!tab.active;
      case "duplicate": return !!tab.isDuplicate;
      default: return false;
    }
  }

  // AND logic: tab must have ALL included statuses
  for (const s of include) {
    if (!hasStatus(s)) return false;
  }
  // AND logic: tab must NOT have ANY excluded statuses
  for (const s of exclude) {
    if (hasStatus(s)) return false;
  }
  return true;
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
      if (!haystack.includes(search)) return false;
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

function render() {
  const filtered = getFilteredTabs();
  const sorted = sortTabs(filtered);
  const groups = groupTabs(sorted);

  updateStats(filtered.length, enrichedTabs.length);
  updateSortHeaders();

  const tbody = document.getElementById("tab-body");
  tbody.innerHTML = "";

  if (groups) {
    for (const [groupName, tabs] of groups) {
      // Group header
      const headerRow = document.createElement("tr");
      headerRow.className = "group-header";
      const headerTd = document.createElement("td");
      headerTd.colSpan = 9;
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
}

function createTabRow(tab) {
  const tr = document.createElement("tr");
  if (tab.isDuplicate) tr.className = "duplicate";

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
  if (tab.favIconUrl) {
    const img = document.createElement("img");
    img.className = "tab-favicon";
    img.src = tab.favIconUrl;
    img.onerror = function () { this.style.display = "none"; };
    titleDiv.appendChild(img);
  }
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
    dedupBtn.title = "Close other duplicates, keep this one";
    dedupBtn.textContent = "Dedup";
    actionsDiv.appendChild(dedupBtn);
  }
  const ignoreDropdown = document.createElement("div");
  ignoreDropdown.className = "ignore-dropdown";
  const ignoreBtn = document.createElement("button");
  ignoreBtn.className = "btn-ignore";
  ignoreBtn.title = "Ignore this tab";
  ignoreBtn.textContent = "Ignore \u25BC";
  ignoreDropdown.appendChild(ignoreBtn);
  const ignoreMenu = document.createElement("div");
  ignoreMenu.className = "ignore-menu";
  const ignoreUrlBtn = document.createElement("button");
  ignoreUrlBtn.className = "btn-ignore-url";
  ignoreUrlBtn.textContent = "Ignore URL";
  ignoreMenu.appendChild(ignoreUrlBtn);
  const ignoreDomainBtn = document.createElement("button");
  ignoreDomainBtn.className = "btn-ignore-domain";
  ignoreDomainBtn.textContent = "Ignore " + tab.domain;
  ignoreMenu.appendChild(ignoreDomainBtn);
  ignoreDropdown.appendChild(ignoreMenu);
  actionsDiv.appendChild(ignoreDropdown);
  const closeBtn = document.createElement("button");
  closeBtn.className = "btn-close";
  closeBtn.dataset.tabId = tab.id;
  closeBtn.title = "Close tab";
  closeBtn.textContent = "\u2715";
  actionsDiv.appendChild(closeBtn);
  actionsTd.appendChild(actionsDiv);
  tr.appendChild(actionsTd);

  // Go button
  tr.querySelector(".btn-goto").addEventListener("click", (e) => {
    e.stopPropagation();
    browser.runtime.sendMessage({
      type: "goToTab",
      tabId: tab.id,
      windowId: tab.windowId,
    });
  });

  // Close button
  tr.querySelector(".btn-close").addEventListener("click", async (e) => {
    e.stopPropagation();
    await browser.runtime.sendMessage({ type: "closeTab", tabId: tab.id });
    loadTabs();
  });

  // Dedup button
  const dedupBtn = tr.querySelector(".btn-dedup");
  if (dedupBtn) {
    dedupBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const normUrl = normalizeUrl(tab.url || "");
      // Find all tabs with the same normalized URL, excluding the current one
      const dupeIds = enrichedTabs
        .filter((t) => t.id !== tab.id && normalizeUrl(t.url || "") === normUrl)
        .map((t) => t.id);
      if (dupeIds.length === 0) return;
      await browser.runtime.sendMessage({ type: "closeTabs", tabIds: dupeIds });
      loadTabs();
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

  // Ignore dropdown toggle
  const ignoreBtnEl = tr.querySelector(".btn-ignore");
  const ignoreMenuEl = tr.querySelector(".ignore-menu");
  ignoreBtnEl.addEventListener("click", (e) => {
    e.stopPropagation();
    // Close any other open ignore menus
    document.querySelectorAll(".ignore-menu.open").forEach((m) => {
      if (m !== ignoreMenuEl) m.classList.remove("open");
    });
    ignoreMenuEl.classList.toggle("open");
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
  const domainCounts = {};
  for (const tab of enrichedTabs) {
    if (tab.domain) {
      domainCounts[tab.domain] = (domainCounts[tab.domain] || 0) + 1;
    }
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
  const result = await browser.storage.local.get(["ignoredUrls", "ignoredDomains"]);
  ignoredUrls = new Set(result.ignoredUrls || []);
  ignoredDomains = new Set(result.ignoredDomains || []);
}

async function saveIgnoreLists() {
  await browser.storage.local.set({
    ignoredUrls: [...ignoredUrls],
    ignoredDomains: [...ignoredDomains],
  });
}

async function ignoreUrl(url) {
  const norm = normalizeUrl(url);
  if (!norm) return;
  ignoredUrls.add(norm);
  await saveIgnoreLists();
  render();
  updateIgnoredPanel();
}

async function ignoreDomain(domain) {
  if (!domain) return;
  ignoredDomains.add(domain);
  await saveIgnoreLists();
  render();
  updateIgnoredPanel();
}

async function unignoreUrl(url) {
  ignoredUrls.delete(url);
  await saveIgnoreLists();
  render();
  updateIgnoredPanel();
}

async function unignoreDomain(domain) {
  ignoredDomains.delete(domain);
  await saveIgnoreLists();
  render();
  updateIgnoredPanel();
}

async function resetAllIgnored() {
  ignoredUrls.clear();
  ignoredDomains.clear();
  await saveIgnoreLists();
  render();
  updateIgnoredPanel();
}

function isIgnored(tab) {
  if (ignoredDomains.has(tab.domain)) return true;
  if (ignoredUrls.has(normalizeUrl(tab.url || ""))) return true;
  return false;
}

function updateIgnoredPanel() {
  const urlList = document.getElementById("ignoredUrlList");
  const domainList = document.getElementById("ignoredDomainList");
  const count = document.getElementById("ignoredCount");

  count.textContent = `${ignoredUrls.size} URLs, ${ignoredDomains.size} domains`;

  urlList.innerHTML = "";
  for (const url of [...ignoredUrls].sort()) {
    const li = document.createElement("li");
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
}

// --- Event listeners ---

// Sort on header click — three-state cycle: desc → asc → off
// Multiple columns supported; click adds to sort, existing column cycles
document.querySelector("thead").addEventListener("click", (e) => {
  const th = e.target.closest("th.sortable");
  if (!th) return;
  const key = th.dataset.sort;

  const existingIdx = currentSort.findIndex((s) => s.key === key);
  if (existingIdx === -1) {
    // New column: add with default direction
    const dir = key === "title" || key === "domain" ? "asc" : "desc";
    currentSort.push({ key, dir });
  } else {
    const existing = currentSort[existingIdx];
    if (existing.dir === "desc") {
      existing.dir = "asc";
    } else {
      // Was asc, remove it (back to default)
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
  if (domainPanel.classList.contains("open")) {
    setTimeout(() => document.getElementById("domainSearch").focus(), 0);
  }
});

// Close dropdown when clicking outside
document.addEventListener("click", (e) => {
  if (!e.target.closest(".domain-filter")) {
    domainPanel.classList.remove("open");
  }
  if (!e.target.closest(".ignore-dropdown")) {
    document.querySelectorAll(".ignore-menu.open").forEach((m) => m.classList.remove("open"));
  }
});

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

// Ignored panel toggle
document.getElementById("toggleIgnoredPanel").addEventListener("click", () => {
  const panel = document.getElementById("ignoredPanel");
  panel.classList.toggle("open");
});

// Reset all ignored
document.getElementById("resetIgnored").addEventListener("click", () => {
  if (confirm("Remove all ignored URLs and domains?")) {
    resetAllIgnored();
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

faviconSlider.addEventListener("input", () => {
  const size = faviconSlider.value;
  applyFaviconSize(size);
  browser.storage.local.set({ faviconSize: Number(size) });
});

// Restore saved favicon size
browser.storage.local.get("faviconSize").then((result) => {
  if (result.faviconSize) applyFaviconSize(result.faviconSize);
});

// Refresh
document.getElementById("refresh").addEventListener("click", loadTabs);

// Keyboard shortcut: Escape clears search
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const search = document.getElementById("search");
    if (search.value) {
      search.value = "";
      render();
    }
  }
});

// --- Init ---
loadTabs();
