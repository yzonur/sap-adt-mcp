import { test } from "node:test";
import assert from "node:assert/strict";

import {
  startPanel,
  configurePanel,
  ensurePanelStarted,
  stopPanel,
  isPanelRunning,
} from "../src/panel.js";
import * as panelTool from "../src/tools/panel.js";

// Minimal fixture: a couple of fake tools + handlers + config. The panel only
// reaches handlers through its curated allowlist, so we register one allowed
// read-only tool (adt_ping) and one tool that is NOT on the allowlist to prove
// it can never be invoked from the wire.
function fixture() {
  const calls = [];
  const tools = [
    {
      name: "adt_ping",
      description: "ping",
      inputSchema: {
        type: "object",
        properties: { system: { type: "string" } },
        required: [],
      },
    },
    {
      name: "adt_set_source", // a write tool — deliberately not on the panel allowlist
      description: "write",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
  ];
  const handlers = {
    adt_ping: async (args) => {
      calls.push(["adt_ping", args]);
      return { content: [{ type: "text", text: "pong" }], isError: false };
    },
    adt_set_source: async (args) => {
      calls.push(["adt_set_source", args]);
      return { content: [{ type: "text", text: "wrote" }], isError: false };
    },
  };
  const config = {
    systems: { E4D: {}, USD: {} },
    defaultSystem: "E4D",
    readOnly: false,
    panel: { enabled: true, port: 0, host: "127.0.0.1" },
  };
  return { tools, handlers, config, calls };
}

function start() {
  const fx = fixture();
  const { server, getUrl } = startPanel({
    tools: fx.tools,
    handlers: fx.handlers,
    config: fx.config,
    version: "9.9.9",
    log: () => {},
  });
  return new Promise((resolve) => {
    server.on("listening", () => {
      const { port } = server.address();
      const token = new URL(getUrl()).searchParams.get("t");
      resolve({ ...fx, server, port, token });
    });
  });
}

test("serves the HTML page without a token", async () => {
  const ctx = await start();
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/`);
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.match(body, /SAP ADT/);
  } finally {
    ctx.server.close();
  }
});

test("/meta requires the token and lists only curated tools", async () => {
  const ctx = await start();
  try {
    const bad = await fetch(`http://127.0.0.1:${ctx.port}/meta`);
    assert.equal(bad.status, 401);

    const ok = await fetch(`http://127.0.0.1:${ctx.port}/meta`, {
      headers: { "x-panel-token": ctx.token },
    });
    assert.equal(ok.status, 200);
    const meta = await ok.json();
    assert.equal(meta.version, "9.9.9");
    assert.deepEqual(meta.systems, ["E4D", "USD"]);
    const names = meta.tools.map((t) => t.name);
    assert.ok(names.includes("adt_ping"));
    // The write tool is never advertised, even though it has a handler.
    assert.ok(!names.includes("adt_set_source"));
  } finally {
    ctx.server.close();
  }
});

test("/call runs an allowlisted read-only handler", async () => {
  const ctx = await start();
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/call`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-panel-token": ctx.token },
      body: JSON.stringify({ name: "adt_ping", args: { system: "E4D" } }),
    });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.equal(out.text, "pong");
    assert.equal(out.isError, false);
    assert.deepEqual(ctx.calls[0], ["adt_ping", { system: "E4D" }]);
  } finally {
    ctx.server.close();
  }
});

test("/call refuses a tool that is not on the allowlist", async () => {
  const ctx = await start();
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/call`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-panel-token": ctx.token },
      body: JSON.stringify({ name: "adt_set_source", args: { foo: 1 } }),
    });
    assert.equal(r.status, 403);
    // The handler must never have been touched.
    assert.equal(ctx.calls.length, 0);
  } finally {
    ctx.server.close();
  }
});

test("/call rejects a bad token", async () => {
  const ctx = await start();
  try {
    const r = await fetch(`http://127.0.0.1:${ctx.port}/call`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-panel-token": "wrong" },
      body: JSON.stringify({ name: "adt_ping", args: {} }),
    });
    assert.equal(r.status, 401);
    assert.equal(ctx.calls.length, 0);
  } finally {
    ctx.server.close();
  }
});

test("ensurePanelStarted is idempotent; stopPanel tears it down", async () => {
  stopPanel(); // clean slate
  const fx = fixture();
  configurePanel({
    tools: fx.tools,
    handlers: fx.handlers,
    config: fx.config,
    version: "1.2.3",
    log: () => {},
  });
  const a = await ensurePanelStarted();
  assert.equal(a.alreadyRunning, false);
  assert.ok(isPanelRunning());

  const b = await ensurePanelStarted();
  assert.equal(b.alreadyRunning, true);
  assert.equal(b.url, a.url); // same listener, same token

  const token = new URL(a.url).searchParams.get("t");
  const base = a.url.split("/?")[0];
  const meta = await fetch(`${base}/meta`, {
    headers: { "x-panel-token": token },
  });
  assert.equal(meta.status, 200);

  const stoppedUrl = stopPanel();
  assert.equal(stoppedUrl, a.url);
  assert.ok(!isPanelRunning());
});

test("adt_open_panel starts the panel (no browser) and adt_close_panel stops it", async () => {
  stopPanel(); // clean slate
  const fx = fixture();
  configurePanel({
    tools: fx.tools,
    handlers: fx.handlers,
    config: fx.config,
    version: "1.0.0",
    log: () => {},
  });
  const handlers = panelTool.register();

  const out = await handlers.adt_open_panel({ open: false });
  const data = JSON.parse(out.content[0].text);
  assert.equal(data.ok, true);
  assert.equal(data.browserOpened, false);
  assert.match(data.url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[a-f0-9]+$/);
  assert.ok(isPanelRunning());

  // Second call is idempotent: same URL, alreadyRunning true.
  const again = JSON.parse((await handlers.adt_open_panel({ open: false })).content[0].text);
  assert.equal(again.alreadyRunning, true);
  assert.equal(again.url, data.url);

  const closed = JSON.parse((await handlers.adt_close_panel({})).content[0].text);
  assert.equal(closed.wasRunning, true);
  assert.equal(closed.stillRunning, false);
  assert.ok(!isPanelRunning());
});
