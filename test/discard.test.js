const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "runtime-ui.test.js"), "utf8");
const dashboard = vm.runInNewContext(source.slice(0, source.indexOf("for (const [selector, type]")) + ";dashboard", { require, __dirname, URL, setImmediate });

// Execute the actual registered broker handler, replacing only browser APIs.
function broker(tabs, browser = "chrome") {
  let listener;
  const responses = [];
  const forbidden = async () => { throw new Error("Discard must not change focus or restore sessions"); };
  const api = {
    action: { onClicked: { addListener() {} } },
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
    tabs: { ...tabs, update: forbidden },
    windows: { update: forbidden },
    sessions: { restore: forbidden },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../background.js"), "utf8"), { [browser]: api });
  const send = (message) => new Promise((resolve) => {
    assert.equal(listener(message, {}, (response) => {
      responses.push(response);
      resolve(response);
    }), true);
  });
  send.responses = responses;
  return send;
}

it("reports a tab becoming active after render through the real broker and UI", async () => {
  let tab = { id: 7, active: false, discarded: false };
  let discardCalls = 0;
  const send = broker({
    query: async () => [{ ...tab }],
    get: async (id) => { assert.equal(id, 7); return { ...tab }; },
    discard: async () => { discardCalls++; },
  });
  const app = dashboard(send);
  await app.settle();
  const button = app.get("tab-body").children[0].querySelector(".btn-discard");
  assert.equal(button.disabled, false);
  app.run('showUndoToast("Earlier close completed.")');
  const recovery = app.get("undo-toast-btn");
  recovery.focus();
  tab.active = true;
  await button.listeners.click({ stopPropagation() {} });
  const response = send.responses.find((entry) => !entry.tabs);
  assert.equal(response.ok, false);
  assert.match(response.error, /active tab.*cannot be discarded/i);
  assert.equal(discardCalls, 0);
  assert.match(app.get("bulkError").textContent, /active tab.*cannot be discarded/i);
  assert.equal(app.get("tab-body").children[0].querySelector(".btn-discard").disabled, true);
  assert.equal(app.get("undo-toast").hidden, false);
  assert.equal(app.get("undo-toast-btn"), recovery);
  assert.equal(app.run("document.activeElement"), recovery);
});

for (const browser of ["browser", "chrome"]) {
  for (const becameActive of [false, true]) {
    it(`rejects fulfilled discard no-op in ${browser}, active race: ${becameActive}`, async () => {
      let tab = { id: 7, active: false, discarded: false };
      const events = [];
      const send = broker({
        query: async () => [{ ...tab }],
        get: async (id) => { assert.equal(id, 7); events.push("get"); return { ...tab }; },
        discard: async (id) => {
          assert.equal(id, 7);
          events.push("discard");
          tab.active = becameActive;
          // Even a returned Chrome Tab cannot replace a current-state check.
          return browser === "browser" ? undefined : { ...tab, discarded: true };
        },
      }, browser);
      const app = dashboard(send);
      await app.settle();
      app.run('showUndoToast("Earlier close completed.")');
      const recovery = app.get("undo-toast-btn");
      app.get("search").focus();
      await app.get("tab-body").children[0].querySelector(".btn-discard")
        .listeners.click({ stopPropagation() {} });
      const response = send.responses.find((entry) => !entry.tabs);
      assert.equal(response.ok, false);
      assert.match(response.error, /not discarded/i);
      assert.deepEqual(events, ["get", "discard", "get"]);
      assert.match(app.get("bulkError").textContent, /not discarded/i);
      assert.equal(app.get("tab-body").children[0].querySelector(".btn-discard").disabled, becameActive);
      assert.equal(app.get("undo-toast").hidden, false);
      assert.equal(app.get("undo-toast-btn"), recovery);
      assert.equal(app.run("document.activeElement"), app.get("search"));
    });
  }
}

it("treats an already discarded inactive tab as idempotent without calling discard again", async () => {
  let discardCalls = 0;
  const send = broker({
    get: async () => ({ id: 7, active: false, discarded: true }),
    discard: async () => { discardCalls++; throw new Error("Redundant discard"); },
  });
  assert.equal((await send({ type: "discardTab", tabId: 7 })).ok, true);
  assert.equal(discardCalls, 0);
});

for (const browser of ["browser", "chrome"]) {
  it(`waits for verified inactive discard success in ${browser} and refreshes the UI`, async () => {
    const tab = { id: 7, active: false, discarded: false };
    const events = [];
    let finishDiscard;
    let finishVerification;
    const send = broker({
      query: async () => [{ ...tab }],
      get: async (id) => {
        assert.equal(id, 7);
        events.push("get");
        if (events.length === 1) return { ...tab };
        return new Promise((resolve) => { finishVerification = () => resolve({ ...tab }); });
      },
      discard: (id) => {
        assert.equal(id, 7);
        events.push("discard");
        return new Promise((resolve) => {
          finishDiscard = () => {
            tab.discarded = true;
            resolve(browser === "browser" ? undefined : { ...tab });
          };
        });
      },
    }, browser);
    const app = dashboard(send);
    await app.settle();
    app.run('showUndoToast("Earlier close completed.")');
    const recovery = app.get("undo-toast-btn");
    const button = app.get("tab-body").children[0].querySelector(".btn-discard");
    button.focus();
    const pending = button.listeners.click({ stopPropagation() {} });
    await app.settle();
    assert.deepEqual(events, ["get", "discard"]);
    assert.equal(send.responses.length, 1, "no acknowledgment before discard settles");
    app.get("search").focus();
    finishDiscard();
    await app.settle();
    assert.deepEqual(events, ["get", "discard", "get"]);
    assert.equal(send.responses.length, 1, "no acknowledgment before postcondition read settles");
    finishVerification();
    await pending;
    assert.equal(send.responses[1].ok, true);
    assert.equal(app.get("bulkError").textContent, "");
    assert.equal(app.get("tab-body").children[0].querySelector(".btn-discard").disabled, true);
    assert.equal(app.get("undo-toast").hidden, false);
    assert.equal(app.get("undo-toast-btn"), recovery);
    assert.equal(app.run("document.activeElement"), app.get("search"));
  });

  for (const stage of ["initial get", "discard", "final get"]) {
    it(`preserves ${stage} rejection in ${browser} through the broker and UI`, async () => {
      const tab = { id: 7, active: false, discarded: false };
      const events = [];
      const error = stage === "discard" ? "Discard denied" : "No tab with id: 7";
      const send = broker({
        query: async () => [{ ...tab }],
        get: async () => {
          events.push("get");
          if (stage === "initial get" || (stage === "final get" && events.length === 3)) throw new Error(error);
          return { ...tab };
        },
        discard: async () => {
          events.push("discard");
          if (stage === "discard") throw new Error(error);
          tab.discarded = true;
        },
      }, browser);
      const app = dashboard(send);
      await app.settle();
      app.run('showUndoToast("Earlier close completed.")');
      const recovery = app.get("undo-toast-btn");
      recovery.focus();
      await app.get("tab-body").children[0].querySelector(".btn-discard")
        .listeners.click({ stopPropagation() {} });
      assert.equal(send.responses[1].ok, false);
      assert.equal(send.responses[1].error, error);
      assert.ok(app.get("bulkError").textContent.includes(error));
      assert.deepEqual(events, stage === "initial get" ? ["get"] :
        stage === "discard" ? ["get", "discard"] : ["get", "discard", "get"]);
      assert.equal(app.get("undo-toast").hidden, false);
      assert.equal(app.get("undo-toast-btn"), recovery);
      assert.equal(app.run("document.activeElement"), recovery);
    });
  }
}

it("verifies Chrome's replacement tab ID after a real discard instead of reporting a stale-ID error", async () => {
  let discarded = false;
  const idsRead = [];
  const send = broker({
    get: async (id) => {
      idsRead.push(id);
      if (discarded && id === 7) throw new Error("No tab with id: 7");
      return { id, active: false, discarded };
    },
    discard: async (id) => {
      assert.equal(id, 7);
      discarded = true;
      return { id: 8, discarded: true };
    },
  });
  const response = await send({ type: "discardTab", tabId: 7 });
  assert.equal(response.ok, true);
  assert.deepEqual(idsRead, [7, 8]);
});

it("disables discard for active and already discarded rows with an explanatory title", async () => {
  const app = dashboard(() => ({ ok: true, tabs: [
    { id: 1, active: true, discarded: false },
    { id: 2, active: false, discarded: true },
    { id: 3, active: false, discarded: false },
  ] }));
  await app.settle();
  const buttons = app.get("tab-body").children.map((row) => row.querySelector(".btn-discard"));
  assert.equal(buttons.length, 3);
  assert.equal(buttons[0].disabled, true);
  assert.match(buttons[0].title, /active tab.*cannot be discarded/i);
  assert.equal(buttons[1].disabled, true);
  assert.match(buttons[1].title, /already discarded/i);
  assert.equal(buttons[2].disabled, false);
});
