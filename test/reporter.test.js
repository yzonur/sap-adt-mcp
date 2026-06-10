import { test } from "node:test";
import assert from "node:assert/strict";
import { createReporter, _internals } from "../src/reporter.js";

const PKG = { version: "9.9.9" };

function baseConfig(overrides = {}) {
  return {
    systems: {
      DEV: {
        host: "https://sap-secret.example.com:44300",
        user: "SUPERUSER",
        password: "hunter2pw9",
        client: "100",
      },
    },
    reporting: {
      enabled: true,
      endpoint: "https://relay.test/report",
      includeArgs: true,
      ...overrides,
    },
  };
}

// Replace global fetch with a recorder for the duration of fn().
async function withCapturedFetch(fn) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

test("redacts host, user, and password before sending", async () => {
  await withCapturedFetch(async (calls) => {
    const reporter = createReporter(baseConfig(), PKG);
    const err = new Error(
      "Boom talking to https://sap-secret.example.com:44300 as SUPERUSER with pw hunter2pw9"
    );
    await reporter.report(err, { tool: "read_source" });

    assert.equal(calls.length, 1);
    const sent = JSON.stringify(calls[0].body);
    assert.ok(!sent.includes("sap-secret.example.com"), "host leaked");
    assert.ok(!sent.includes("SUPERUSER"), "user leaked");
    assert.ok(!sent.includes("hunter2pw9"), "password leaked");
    assert.ok(sent.includes("<redacted>"), "nothing was redacted");
    assert.equal(calls[0].body.tool, "read_source");
    assert.equal(calls[0].body.version, "9.9.9");
  });
});

test("redacts generic IPs and emails not present in config", async () => {
  await withCapturedFetch(async (calls) => {
    const reporter = createReporter(baseConfig(), PKG);
    await reporter.report(new Error("failed at 10.20.30.40 for jane.doe@corp.com"), {});
    const sent = JSON.stringify(calls[0].body);
    assert.ok(!sent.includes("10.20.30.40"));
    assert.ok(!sent.includes("jane.doe@corp.com"));
    assert.ok(sent.includes("<ip>") && sent.includes("<email>"));
  });
});

test("skips expected/user-side errors", async () => {
  await withCapturedFetch(async (calls) => {
    const reporter = createReporter(baseConfig(), PKG);

    const readonly = new Error("write blocked");
    readonly.name = "ReadOnlyViolationError";
    await reporter.report(readonly, {});

    const network = new Error("connect ECONNREFUSED");
    network.code = "ECONNREFUSED";
    await reporter.report(network, {});

    await reporter.report(new Error("HTTP 401 unauthorized"), {});
    await reporter.report(new Error("No config found. Set SAP_ADT_MCP_CONFIG"), {});

    assert.equal(calls.length, 0, "an expected error was reported");
  });
});

test("reports genuine unexpected errors", async () => {
  await withCapturedFetch(async (calls) => {
    const reporter = createReporter(baseConfig(), PKG);
    await reporter.report(new TypeError("Cannot read properties of undefined"), {
      tool: "search",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.errorName, "TypeError");
  });
});

test("de-dups identical errors within a process", async () => {
  await withCapturedFetch(async (calls) => {
    const reporter = createReporter(baseConfig(), PKG);
    const mk = () => new RangeError("index out of bounds");
    await reporter.report(mk(), {});
    await reporter.report(mk(), {});
    await reporter.report(mk(), {});
    assert.equal(calls.length, 1, "same fingerprint sent more than once");
  });
});

test("respects enabled=false and SAP_ADT_MCP_REPORT off-switch semantics", async () => {
  await withCapturedFetch(async (calls) => {
    const reporter = createReporter(baseConfig({ enabled: false }), PKG);
    assert.equal(reporter.enabled, false);
    await reporter.report(new Error("should not send"), {});
    assert.equal(calls.length, 0);
  });
});

test("includeArgs=false omits args; true includes redacted args", async () => {
  await withCapturedFetch(async (calls) => {
    const off = createReporter(baseConfig({ includeArgs: false }), PKG);
    await off.report(new Error("boom one"), { args: { object: "ZCL_FOO" } });
    assert.equal(calls[0].body.args, undefined);

    const on = createReporter(baseConfig(), PKG);
    await on.report(new Error("boom two"), {
      args: { host: "https://sap-secret.example.com:44300", user: "SUPERUSER" },
    });
    const argsField = calls[1].body.args;
    assert.ok(typeof argsField === "string");
    assert.ok(!argsField.includes("sap-secret.example.com"));
    assert.ok(!argsField.includes("SUPERUSER"));
  });
});

test("fingerprint is stable across run-specific numbers but varies by error type", () => {
  const { fingerprint } = _internals;
  const a = new Error("object 4711 is locked by transport K900123");
  const b = new Error("object 8899 is locked by transport K900999");
  // Force identical stacks so only the message drives the difference.
  a.stack = b.stack = "Error\n    at f (src/tools/lock.js:42:7)";
  assert.equal(fingerprint(a), fingerprint(b), "numbers should be normalised away");

  const c = new TypeError("object 4711 is locked by transport K900123");
  c.stack = a.stack;
  assert.notEqual(fingerprint(a), fingerprint(c), "error type should matter");
});
