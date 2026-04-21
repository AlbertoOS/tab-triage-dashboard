const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  getDomain,
  normalizeUrl,
  formatAge,
  getAgeBucket,
  getStatusList,
  formatDate,
  matchesAgeFilter,
  matchesStatusFilter,
} = require("../utils.js");

// --- getDomain ---

describe("getDomain", () => {
  it("extracts hostname from URL", () => {
    assert.equal(getDomain("https://example.com/path"), "example.com");
  });

  it("strips www prefix", () => {
    assert.equal(getDomain("https://www.example.com/path"), "example.com");
  });

  it("returns empty string for invalid URLs", () => {
    assert.equal(getDomain("not-a-url"), "");
  });

  it("returns empty string for empty input", () => {
    assert.equal(getDomain(""), "");
  });

  it("handles subdomains", () => {
    assert.equal(getDomain("https://sub.example.com"), "sub.example.com");
  });
});

// --- normalizeUrl ---

describe("normalizeUrl", () => {
  it("normalizes URL to origin + pathname + search", () => {
    assert.equal(
      normalizeUrl("https://example.com/path?q=1#hash"),
      "https://example.com/path?q=1",
    );
  });

  it("strips trailing slashes", () => {
    assert.equal(
      normalizeUrl("https://example.com/path/"),
      "https://example.com/path",
    );
  });

  it("returns original string for invalid URLs", () => {
    assert.equal(normalizeUrl("not-a-url"), "not-a-url");
  });

  it("handles bare domain", () => {
    assert.equal(
      normalizeUrl("https://example.com"),
      "https://example.com",
    );
  });
});

// --- formatAge ---

describe("formatAge", () => {
  it("formats seconds", () => {
    assert.equal(formatAge(30000), "30s ago");
  });

  it("formats minutes", () => {
    assert.equal(formatAge(5 * 60 * 1000), "5m ago");
  });

  it("formats hours", () => {
    assert.equal(formatAge(3 * 3600 * 1000), "3h ago");
  });

  it("formats days", () => {
    assert.equal(formatAge(10 * 24 * 3600 * 1000), "10d ago");
  });

  it("formats months", () => {
    assert.equal(formatAge(60 * 24 * 3600 * 1000), "2mo ago");
  });

  it("returns 0s for zero", () => {
    assert.equal(formatAge(0), "0s ago");
  });
});

// --- getAgeBucket ---

describe("getAgeBucket", () => {
  it("returns < 1 hour for 30 minutes", () => {
    assert.equal(getAgeBucket(30 * 60 * 1000), "< 1 hour");
  });

  it("returns < 24 hours for 12 hours", () => {
    assert.equal(getAgeBucket(12 * 3600 * 1000), "< 24 hours");
  });

  it("returns < 7 days for 3 days", () => {
    assert.equal(getAgeBucket(3 * 24 * 3600 * 1000), "< 7 days");
  });

  it("returns < 30 days for 15 days", () => {
    assert.equal(getAgeBucket(15 * 24 * 3600 * 1000), "< 30 days");
  });

  it("returns 30-90 days for 60 days", () => {
    assert.equal(getAgeBucket(60 * 24 * 3600 * 1000), "30-90 days");
  });

  it("returns 90-180 days for 120 days", () => {
    assert.equal(getAgeBucket(120 * 24 * 3600 * 1000), "90-180 days");
  });

  it("returns 180-365 days for 200 days", () => {
    assert.equal(getAgeBucket(200 * 24 * 3600 * 1000), "180-365 days");
  });

  it("returns 365+ days for 400 days", () => {
    assert.equal(getAgeBucket(400 * 24 * 3600 * 1000), "365+ days");
  });
});

// --- getStatusList ---

describe("getStatusList", () => {
  it("returns empty array for tab with no statuses", () => {
    assert.deepEqual(getStatusList({}), []);
  });

  it("returns pinned for pinned tab", () => {
    assert.deepEqual(getStatusList({ pinned: true }), ["pinned"]);
  });

  it("returns multiple statuses", () => {
    assert.deepEqual(
      getStatusList({ pinned: true, audible: true, active: true }),
      ["pinned", "audible", "active"],
    );
  });

  it("handles muted tab with mutedInfo", () => {
    assert.deepEqual(
      getStatusList({ mutedInfo: { muted: true } }),
      ["muted"],
    );
  });

  it("ignores mutedInfo when muted is false", () => {
    assert.deepEqual(
      getStatusList({ mutedInfo: { muted: false } }),
      [],
    );
  });
});

// --- formatDate ---

describe("formatDate", () => {
  it("returns em-dash for falsy input", () => {
    assert.equal(formatDate(0), "\u2014");
    assert.equal(formatDate(null), "\u2014");
    assert.equal(formatDate(undefined), "\u2014");
  });

  it("formats a timestamp as YYYY-MM-DD HH:MM", () => {
    // Use a known UTC timestamp and check the format pattern
    const result = formatDate(1700000000000);
    assert.match(result, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

// --- matchesAgeFilter ---

describe("matchesAgeFilter", () => {
  it("matches tab under 1 hour with 1h filter", () => {
    assert.equal(matchesAgeFilter({ ageMs: 30 * 60 * 1000 }, ["1h"]), true);
  });

  it("does not match tab over 1 hour with 1h filter", () => {
    assert.equal(matchesAgeFilter({ ageMs: 2 * 3600 * 1000 }, ["1h"]), false);
  });

  it("uses OR logic — matches if any filter applies", () => {
    assert.equal(
      matchesAgeFilter({ ageMs: 2 * 3600 * 1000 }, ["1h", "24h"]),
      true,
    );
  });

  it("matches 30d+ for old tabs", () => {
    assert.equal(
      matchesAgeFilter({ ageMs: 45 * 24 * 3600 * 1000 }, ["30d+"]),
      true,
    );
  });

  it("does not match 30d+ for recent tabs", () => {
    assert.equal(
      matchesAgeFilter({ ageMs: 10 * 24 * 3600 * 1000 }, ["30d+"]),
      false,
    );
  });

  it("returns false when no filters match", () => {
    assert.equal(
      matchesAgeFilter({ ageMs: 2 * 3600 * 1000 }, ["365d+"]),
      false,
    );
  });
});

// --- matchesStatusFilter ---

describe("matchesStatusFilter", () => {
  it("returns true when no filters are set", () => {
    assert.equal(
      matchesStatusFilter({}, { include: [], exclude: [] }),
      true,
    );
  });

  it("includes pinned tabs", () => {
    assert.equal(
      matchesStatusFilter({ pinned: true }, { include: ["pinned"], exclude: [] }),
      true,
    );
  });

  it("excludes non-pinned tabs when pinned is included", () => {
    assert.equal(
      matchesStatusFilter({ pinned: false }, { include: ["pinned"], exclude: [] }),
      false,
    );
  });

  it("excludes pinned tabs when pinned is excluded", () => {
    assert.equal(
      matchesStatusFilter({ pinned: true }, { include: [], exclude: ["pinned"] }),
      false,
    );
  });

  it("includes non-pinned tabs when pinned is excluded", () => {
    assert.equal(
      matchesStatusFilter({ pinned: false }, { include: [], exclude: ["pinned"] }),
      true,
    );
  });

  it("AND logic: include pinned AND active", () => {
    assert.equal(
      matchesStatusFilter(
        { pinned: true, active: true },
        { include: ["pinned", "active"], exclude: [] },
      ),
      true,
    );
    assert.equal(
      matchesStatusFilter(
        { pinned: true, active: false },
        { include: ["pinned", "active"], exclude: [] },
      ),
      false,
    );
  });

  it("combined include and exclude", () => {
    assert.equal(
      matchesStatusFilter(
        { pinned: true, isDuplicate: false },
        { include: ["pinned"], exclude: ["duplicate"] },
      ),
      true,
    );
    assert.equal(
      matchesStatusFilter(
        { pinned: true, isDuplicate: true },
        { include: ["pinned"], exclude: ["duplicate"] },
      ),
      false,
    );
  });

  it("handles muted status", () => {
    assert.equal(
      matchesStatusFilter(
        { mutedInfo: { muted: true } },
        { include: ["muted"], exclude: [] },
      ),
      true,
    );
    assert.equal(
      matchesStatusFilter(
        { mutedInfo: { muted: false } },
        { include: ["muted"], exclude: [] },
      ),
      false,
    );
  });
});
