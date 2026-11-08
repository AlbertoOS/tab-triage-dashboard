const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Reuse full-source execution; only DOM and extension API boundaries are fake.
const fixture = fs.readFileSync(path.join(__dirname, "runtime-ui.test.js"), "utf8");
const dashboard = vm.runInNewContext(
  fixture.slice(0, fixture.indexOf("for (const [selector, type]")) + ";dashboard",
  { require, __dirname, URL, console, setImmediate },
);
const html = fs.readFileSync(path.join(__dirname, "../triage.html"), "utf8");
function createApp(getManifest) {
  return dashboard(() => ({ ok: true, tabs: [] }), {}, { runtime: {
    getManifest: arguments.length ? getManifest : () => ({ version: "8.7.6" }),
  } });
}

it("opens header Help/About with the installed runtime version, not package metadata", async () => {
  assert.match(html, /<header>[\s\S]*<button\b[^>]*id="helpAbout"[^>]*>Help \/ About<\/button>[\s\S]*<\/header>/);
  assert.match(html, /<dialog\b[^>]*id="helpDialog"[^>]*aria-labelledby="helpTitle"/);
  const app = createApp();
  await app.settle();
  app.get("helpAbout").listeners.click();
  assert.equal(app.get("helpDialog").open, true);
  assert.equal(app.get("helpVersion").textContent, "Installed version: 8.7.6");
  assert.notEqual(app.get("helpVersion").textContent, `Installed version: ${require("../package.json").version}`);
  assert.equal(app.run("document.activeElement"), app.get("helpClose"));
  assert.deepEqual(Array.from(app.messages, (message) => message.type), ["getTabs"], "Help must not fetch releases or change tabs");
});

it("closes Help with its button and returns focus to the header opener", async () => {
  const app = createApp();
  await app.settle();
  app.get("helpAbout").focus();
  app.get("helpAbout").listeners.click();
  assert.equal(typeof app.get("helpClose").listeners.click, "function", "Close must be wired");
  app.get("helpClose").listeners.click();
  assert.equal(app.get("helpDialog").open, false);
  assert.equal(app.run("document.activeElement"), app.get("helpAbout"));
});

it("gives Help Escape priority without changing search, filters, selection or recovery", async () => {
  const app = createApp();
  await app.settle();
  app.get("search").value = "keep this search";
  app.get("groupBy").value = "domain";
  app.run('currentSort = [{ key: "title", dir: "asc" }]; collapsedGroups.add("example.com"); ignoredUrls.add("https://example.com"); ignoredDomains.add("example.org"); showIgnored = true; selectedTabIds.add(123);');
  app.run('showUndoToast("Earlier close completed.")');
  const snapshot = () => app.run('JSON.stringify({ currentSort, collapsedGroups: [...collapsedGroups], ignoredUrls: [...ignoredUrls], ignoredDomains: [...ignoredDomains], showIgnored, selectedTabIds: [...selectedTabIds] })');
  const before = snapshot();
  const recovery = app.get("undo-toast-btn");
  app.get("helpAbout").focus();
  app.get("helpAbout").listeners.click();
  let prevented = false;
  app.documentListeners.keydown({ key: "Escape", preventDefault() { prevented = true; } });
  assert.equal(app.get("helpDialog").open, false, "Escape closes Help, not the search");
  assert.equal(prevented, true, "consume the native Escape default");
  assert.equal(app.get("search").value, "keep this search");
  assert.equal(app.get("groupBy").value, "domain");
  assert.equal(snapshot(), before);
  assert.equal(app.get("undo-toast").hidden, false);
  assert.equal(app.get("undo-toast-btn"), recovery);
  assert.equal(app.run("document.activeElement"), app.get("helpAbout"));
  assert.equal(app.messages.length, 1);
  app.documentListeners.keydown({ key: "Escape" });
  assert.equal(app.get("search").value, "", "ordinary Escape still clears search after Help closes");
});

it("keeps search intact through a held Escape dismissal until a separate Escape press", async () => {
  const app = createApp();
  await app.settle();
  app.get("search").value = "keep this search";
  app.get("helpAbout").listeners.click();
  app.documentListeners.keydown({ key: "Escape", repeat: false, preventDefault() {} });
  assert.equal(app.get("helpDialog").open, false);
  for (let i = 0; i < 3; i++) {
    app.documentListeners.keydown({ key: "Escape", repeat: true, preventDefault() {} });
    assert.equal(app.get("search").value, "keep this search");
  }
  assert.equal(app.run("document.activeElement"), app.get("helpAbout"));
  app.documentListeners.keydown({ key: "Escape", repeat: false, preventDefault() {} });
  assert.equal(app.get("search").value, "", "a separate press still clears search");
});

it("documents the current tab operations without advertising planned safeguards", () => {
  const help = html.match(/<dialog\b[^>]*id="helpDialog"[^>]*>([\s\S]*?)<\/dialog>/)?.[1] || "";
  const text = help.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  for (const contract of [
    /default direction → reverse → off/,
    /Title and Domain start A–Z; Age starts oldest first/,
    /age buckets match any selected bucket \(OR\)/,
    /status requirements all apply \(AND\)/,
    /selected domains match any checked domain/i,
    /No domains checked means all domains/,
    /Show ignored only.*only ignored tabs/,
    /Dedup.*keeps the clicked tab.*other loaded copies.*normalized URL/,
    /including filtered-out and ignored tabs across windows/,
    /does not protect other pinned or active copies/,
    /Export selected links.*Export all links.*regardless of filters and ignores/,
    /one URL per line.*current sort order.*Duplicate URLs are preserved/,
    /Dashboard tabs and empty URLs are excluded/,
    /browser chooses.*one tab or window session.*not an exact undo/,
    /Private tabs.*may not be recoverable/,
    /display clusters.*not native browser tab groups/,
  ]) assert.match(text, contract);
});

it("offers only public secure project/support links and warns before public sharing", () => {
  const help = html.match(/<dialog\b[^>]*id="helpDialog"[^>]*>([\s\S]*?)<\/dialog>/)?.[1] || "";
  const anchors = [...help.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)];
  const project = "https://github.com/AlbertoOS/tab-triage-dashboard";
  assert.deepEqual(anchors.map(([, attributes]) => attributes.match(/href="([^"]+)"/)?.[1]),
    [project, `${project}/issues`, `${project}/releases`, `${project}/blob/main/PRIVACY.md`]);
  for (const [, attributes] of anchors) {
    assert.match(attributes, /target="_blank"/);
    assert.match(attributes, /rel="noopener noreferrer"/);
  }
  assert.match(help, /GitHub login/);
  assert.match(help, /Issues are public/);
  assert.match(help, /Do not post private tab URLs, tab lists, exports or screenshots containing sensitive information/);
  assert.match(help, /no application backend or analytics/);
  assert.doesNotMatch(help, /github\.io|showcase|href="PRIVACY\.md"|latest version/i);
});

it("bounds the Help surface for narrow/zoomed viewports and keeps keyboard focus visible", () => {
  const css = fs.readFileSync(path.join(__dirname, "../triage.css"), "utf8");
  const dialog = css.match(/#helpDialog\s*\{([^}]+)\}/)?.[1] || "";
  assert.match(dialog, /width:\s*min\(760px, calc\(100vw - 32px\)\)/);
  assert.match(dialog, /max-height:\s*calc\(100vh - 32px\)/);
  assert.match(dialog, /overflow-y:\s*auto/);
  assert.match(dialog, /overflow-wrap:\s*anywhere/);
  assert.match(dialog, /margin:\s*auto/);
  assert.doesNotMatch(dialog, /display:\s*(flex|block)/, "closed dialogs must retain native hidden behavior");
  assert.match(css, /#helpAbout:focus-visible,\s*#helpDialog :focus-visible\s*\{[^}]*outline:\s*2px solid var\(--text\)/);
  assert.match(css, /\.help-heading\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/);
  assert.match(css, /\.help-links\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /header\s*\{[^}]*flex-wrap:\s*wrap/);
});

it("treats runtime version markup as literal text and rereads installed metadata on reopen", async () => {
  let version = '<img src="invalid" onerror="alert(1)">';
  const app = createApp(() => ({ version }));
  await app.settle();
  const label = app.get("helpVersion");
  Object.defineProperty(label, "innerHTML", { set() { assert.fail("runtime metadata must not enter an HTML sink"); } });
  app.get("helpAbout").listeners.click();
  assert.equal(label.textContent, `Installed version: ${version}`);
  assert.equal(label.children.length, 0);
  app.get("helpClose").listeners.click();
  version = "9.8.7";
  app.get("helpAbout").listeners.click();
  assert.equal(label.textContent, "Installed version: 9.8.7");
});

it("delegates Tab and Shift+Tab to native modal navigation instead of intercepting them", async () => {
  const app = createApp();
  await app.settle();
  const dialog = app.get("helpDialog");
  assert.equal(dialog.tag, "dialog");
  assert.equal(dialog.getAttribute("aria-labelledby"), "helpTitle");
  assert.equal(dialog.getAttribute("tabindex"), null);
  assert.equal(dialog.getAttribute("open"), null);
  assert.match(html, /<button\b[^>]*id="helpClose"[^>]*autofocus/);
  assert.equal(dialog.contains(app.get("helpClose")), true);
  assert.equal(dialog.querySelector("nav").children.length, 4);
  app.get("helpAbout").listeners.click();
  for (const shiftKey of [false, true]) {
    app.documentListeners.keydown({ key: "Tab", shiftKey,
      preventDefault() { assert.fail("native modal Tab traversal must stay enabled"); } });
    assert.equal(dialog.open, true);
  }
  // Native cancel also ends in a close event; test that handler without pretending
  // this boundary fixture implements the browser's cancel/default-action algorithm.
  dialog.close();
  assert.equal(app.run("document.activeElement"), app.get("helpAbout"));
});

it("keeps Help focus and domain/search/sort state during targeted dashboard refresh", async () => {
  let tabs = [{ id: 1, title: "Example", url: "https://example.com", windowId: 1 }];
  const app = dashboard(() => ({ ok: true, tabs }), {}, { runtime: { getManifest: () => ({ version: "8.7.6" }) } });
  await app.settle();
  app.get("search").value = "Example";
  const domain = app.get("domainList").children[0].querySelector("input");
  domain.checked = true;
  domain.listeners.change();
  app.get("selectFiltered").listeners.click();
  app.run('currentSort = [{ key: "title", dir: "asc" }]');
  app.get("helpAbout").listeners.click();
  tabs = [...tabs, { id: 2, title: "Example two", url: "https://other.example", windowId: 2 }];
  let response;
  const accepted = app.messageListeners[0]({ type: "refreshDashboard", tabId: 100 }, {}, (value) => { response = value; });
  await app.settle();
  assert.equal(accepted, true);
  assert.equal(response.ok, true);
  assert.equal(app.get("helpDialog").open, true);
  assert.equal(app.run("document.activeElement"), app.get("helpClose"));
  assert.equal(app.get("search").value, "Example");
  assert.deepEqual(Array.from(app.run("getSelectedDomains()")), ["example.com"]);
  assert.deepEqual(Array.from(app.run("selectedTabIds")), [1]);
  assert.equal(app.run('currentSort[0].key'), "title");
  assert.equal(app.run("allTabs.length"), 2);
  assert.equal(app.get("tab-body").children.length, 1);
});

for (const [label, getManifest] of [
  ["missing", undefined],
  ["throws", () => { throw new Error("Manifest unavailable"); }],
  ["no manifest", () => undefined],
  ["no version", () => ({})],
  ["empty version", () => ({ version: "" })],
  ["non-string version", () => ({ version: 15 })],
]) {
  it(`keeps startup and Help usable with an honest unknown version when getManifest is ${label}`, async () => {
    const app = createApp(getManifest);
    await app.settle();
    assert.equal(app.messages.length, 1);
    assert.doesNotThrow(() => app.get("helpAbout").listeners.click());
    assert.equal(app.get("helpDialog").open, true);
    assert.equal(app.get("helpVersion").textContent, "Installed version: unknown");
    assert.equal(app.get("bulkError").textContent, "");
  });
}
