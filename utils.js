// Tab Triage Dashboard — pure utility functions
// Works in both browser (global scope) and Node.js (module.exports)

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

// Node.js module export (ignored in browser)
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    getDomain,
    normalizeUrl,
    formatAge,
    getAgeBucket,
    getStatusList,
    formatDate,
    matchesAgeFilter,
    matchesStatusFilter,
  };
}
