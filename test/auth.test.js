// Secret resolvers (env / keychain / dpapi), the per-system `auth` block and
// how the client turns it into headers and TLS options.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MockAgent, setGlobalDispatcher } from "undici";

import {
  resolveSecret,
  storeSecret,
  setExecFileSyncForTests,
  setSpawnSyncForTests,
  KEYCHAIN_SERVICE,
} from "../src/secrets.js";
import { loadConfig } from "../src/config.js";
import {
  AdtClient,
  BearerTokenRejectedError,
  buildAuthHeader,
  buildConnectOptions,
} from "../src/adt-client.js";
import { _internals } from "../src/reporter.js";

afterEach(() => {
  setExecFileSyncForTests(null);
  setSpawnSyncForTests(null);
});

function fakeExec(handler) {
  const calls = [];
  setExecFileSyncForTests((file, args, opts) => {
    calls.push({ file, args, opts });
    return handler(file, args, opts);
  });
  return calls;
}

function withConfig(obj, fn) {
  const dir = mkdtempSync(join(tmpdir(), "sap-adt-auth-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(typeof obj === "function" ? obj(dir) : obj));
  const prev = process.env.SAP_ADT_MCP_CONFIG;
  process.env.SAP_ADT_MCP_CONFIG = path;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.SAP_ADT_MCP_CONFIG;
    else process.env.SAP_ADT_MCP_CONFIG = prev;
  }
}

// --- resolveSecret -----------------------------------------------------------

test("resolveSecret: plain value and env: keep working", () => {
  assert.equal(resolveSecret("plain", "L"), "plain");
  process.env.SAP_ADT_TEST_SECRET = "from-env";
  try {
    assert.equal(resolveSecret("env:SAP_ADT_TEST_SECRET", "L"), "from-env");
  } finally {
    delete process.env.SAP_ADT_TEST_SECRET;
  }
  assert.throws(() => resolveSecret("env:SAP_ADT_NOPE_X", "System X: password"), /System X: password: env var SAP_ADT_NOPE_X is not set/);
  assert.throws(() => resolveSecret(42, "System X: password"), /System X: password must be a string/);
});

function fakeSpawn(result) {
  const calls = [];
  setSpawnSyncForTests((file, args) => {
    calls.push({ file, args });
    return result;
  });
  return calls;
}

test("resolveSecret: keychain on macOS parses `security -g` (ASCII form)", () => {
  const calls = fakeSpawn({ status: 0, stderr: 'keychain: "x"\npassword: "s3 "cret"\n' });
  assert.equal(resolveSecret("keychain:DEV", "L", { platform: "darwin" }), 's3 "cret');
  assert.equal(calls[0].file, "security");
  assert.deepEqual(calls[0].args, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "DEV", "-g"]);
});

test("resolveSecret: keychain on macOS decodes the hex form of non-ASCII passwords", () => {
  // Real `security -g` output for the password smoke-pä$$"q (captured on macOS).
  fakeSpawn({ status: 0, stderr: 'password: 0x736D6F6B652D70C3A424242271  "smoke-p\\303\\244$$"q"\n' });
  assert.equal(resolveSecret("keychain:DEV", "L", { platform: "darwin" }), 'smoke-pä$$"q');
});

test("resolveSecret: keychain on macOS reports a missing entry", () => {
  fakeSpawn({ status: 44, stderr: "The specified item could not be found in the keychain." });
  assert.throws(
    () => resolveSecret("keychain:DEV", "L", { platform: "darwin" }),
    /no keychain entry .*account "DEV".*set-password DEV/
  );
});

test("resolveSecret: keychain on Linux calls `secret-tool lookup`", () => {
  const calls = fakeExec(() => "pw");
  assert.equal(resolveSecret("keychain:QAS", "L", { platform: "linux" }), "pw");
  assert.equal(calls[0].file, "secret-tool");
  assert.deepEqual(calls[0].args, ["lookup", "service", KEYCHAIN_SERVICE, "account", "QAS"]);
});

test("resolveSecret: keychain errors are actionable", () => {
  fakeExec(() => {
    throw Object.assign(new Error("exit 1"), { status: 1 });
  });
  assert.throws(
    () => resolveSecret("keychain:DEV", "L", { platform: "linux" }),
    /no keychain entry .*account "DEV".*set-password DEV/
  );
  fakeExec(() => {
    throw Object.assign(new Error("spawn"), { code: "ENOENT" });
  });
  assert.throws(() => resolveSecret("keychain:DEV", "L", { platform: "linux" }), /secret-tool" was not found.*libsecret/);
  assert.throws(() => resolveSecret("keychain:DEV", "L", { platform: "win32" }), /dpapi:/);
  assert.throws(() => resolveSecret("keychain:", "L", { platform: "darwin" }), /needs an account name/);
});

test("resolveSecret: dpapi decrypts via PowerShell over stdin, Windows only", () => {
  const calls = fakeExec((_f, _a, opts) => {
    assert.equal(opts.input, "QkxPQg==");
    return Buffer.from("pässword", "utf8").toString("base64");
  });
  assert.equal(resolveSecret("dpapi:QkxPQg==", "L", { platform: "win32" }), "pässword");
  assert.equal(calls[0].file, "powershell.exe");
  assert.ok(!calls[0].args.join(" ").includes("QkxPQg=="), "blob must not be on argv");
  assert.throws(() => resolveSecret("dpapi:QkxPQg==", "L", { platform: "darwin" }), /only be decrypted on Windows/);
});

test("storeSecret: Linux pipes the secret to secret-tool on stdin", () => {
  const calls = fakeExec(() => "");
  assert.equal(storeSecret("DEV", "pw!", { platform: "linux" }), "keychain:DEV");
  assert.equal(calls[0].opts.input, "pw!");
  assert.ok(!calls[0].args.includes("pw!"));
});

test("storeSecret: Windows returns a dpapi: reference", () => {
  fakeExec(() => "ENCRYPTED==\r\n");
  assert.equal(storeSecret("DEV", "pw", { platform: "win32" }), "dpapi:ENCRYPTED==");
});

// --- config `auth` block -----------------------------------------------------

test("config: no auth block means basic and still requires user/password", () => {
  withConfig({ systems: { A: { host: "https://h", password: "p" } } }, () => {
    assert.throws(() => loadConfig(), /A\.user must be a non-empty string/);
  });
  withConfig({ systems: { A: { host: "https://h", user: "U", password: "p" } } }, () => {
    assert.deepEqual(loadConfig().systems.A.auth, { type: "basic" });
  });
});

test("config: bearer auth needs no user/password and resolves the token", () => {
  process.env.SAP_ADT_TEST_TOKEN = "tok-123";
  try {
    withConfig(
      { systems: { BTP: { host: "https://x.abap.eu10.hana.ondemand.com", auth: { type: "bearer", token: "env:SAP_ADT_TEST_TOKEN" } } } },
      () => {
        const p = loadConfig().systems.BTP;
        assert.deepEqual(p.auth, { type: "bearer", token: "tok-123" });
        assert.equal(p.user, undefined);
        assert.equal(p.password, undefined);
      }
    );
  } finally {
    delete process.env.SAP_ADT_TEST_TOKEN;
  }
});

test("config: certificate auth reads pfx / cert+key files at load", () => {
  withConfig(
    (dir) => {
      writeFileSync(join(dir, "c.pem"), "CERT");
      writeFileSync(join(dir, "k.pem"), "KEY");
      return {
        systems: {
          P: { host: "https://h", user: "U", auth: { type: "certificate", cert: join(dir, "c.pem"), key: join(dir, "k.pem"), passphrase: "pp" } },
        },
      };
    },
    () => {
      const { auth, user, password } = loadConfig().systems.P;
      assert.equal(auth.type, "certificate");
      assert.equal(auth.cert.toString(), "CERT");
      assert.equal(auth.key.toString(), "KEY");
      assert.equal(auth.passphrase, "pp");
      assert.equal(user, "U");
      assert.equal(password, undefined);
    }
  );
  withConfig({ systems: { P: { host: "https://h", auth: { type: "certificate", pfx: "/nonexistent/x.p12" } } } }, () => {
    assert.throws(() => loadConfig(), /P\.auth\.pfx: cannot read/);
  });
  withConfig({ systems: { P: { host: "https://h", auth: { type: "certificate", cert: "/x" } } } }, () => {
    assert.throws(() => loadConfig(), /needs "pfx", or both "cert" and "key"/);
  });
  withConfig({ systems: { P: { host: "https://h", auth: { type: "saml" } } } }, () => {
    assert.throws(() => loadConfig(), /auth\.type must be "basic", "certificate" or "bearer"/);
  });
});

// --- client wiring -----------------------------------------------------------

test("buildAuthHeader: basic / bearer / certificate", () => {
  assert.equal(buildAuthHeader({ user: "U", password: "P" }), "Basic " + Buffer.from("U:P").toString("base64"));
  assert.equal(buildAuthHeader({ auth: { type: "bearer", token: "T" } }), "Bearer T");
  assert.equal(buildAuthHeader({ auth: { type: "certificate", pfx: Buffer.from("x") } }), null);
});

test("buildConnectOptions: TLS options only when needed", () => {
  assert.equal(buildConnectOptions({ user: "U", password: "P" }), undefined);
  assert.deepEqual(buildConnectOptions({ rejectUnauthorized: false }), { rejectUnauthorized: false });
  const pfx = Buffer.from("PFX");
  assert.deepEqual(
    buildConnectOptions({ rejectUnauthorized: true, auth: { type: "certificate", pfx, passphrase: "pp" } }),
    { pfx, passphrase: "pp" }
  );
});

const HOST = "http://sap.test:8000";

test("bearer: request carries the token, sap-client and the CSRF handshake", async () => {
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  const pool = mock.get(HOST);
  const seen = [];
  pool.intercept({ method: "GET", path: /\/sap\/bc\/adt\/discovery\?sap-client=100/ }).reply((req) => {
    seen.push(req.headers.authorization);
    return { statusCode: 200, data: "<x/>", responseOptions: { headers: { "x-csrf-token": "TOK" } } };
  });
  pool.intercept({ method: "POST", path: /\/sap\/bc\/adt\/activation\?sap-client=100/ }).reply((req) => {
    seen.push(req.headers.authorization, req.headers["x-csrf-token"]);
    return { statusCode: 200, data: "<ok/>" };
  });
  const c = new AdtClient({ host: HOST, client: "100", auth: { type: "bearer", token: "abc" } });
  const res = await c.request({ method: "POST", path: "/sap/bc/adt/activation", body: "<x/>" });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ["Bearer abc", "Bearer abc", "TOK"]);
});

test("bearer: a 401 throws an actionable, non-reportable error", async () => {
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  mock.get(HOST).intercept({ method: "GET", path: /\/sap\/bc\/adt\/discovery/ }).reply(401, "expired");
  const c = new AdtClient({ host: HOST, auth: { type: "bearer", token: "old" } });
  const err = await c.request({ path: "/sap/bc/adt/discovery" }).catch((e) => e);
  assert.ok(err instanceof BearerTokenRejectedError);
  assert.match(err.message, /expired or is invalid/);
  assert.equal(_internals.shouldReport(err), false);
});

test("basic: a 401 is still returned to the caller, not thrown", async () => {
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);
  mock.get(HOST).intercept({ method: "GET", path: /\/sap\/bc\/adt\/discovery/ }).reply(401, "no");
  const c = new AdtClient({ host: HOST, user: "U", password: "P" });
  const res = await c.request({ path: "/sap/bc/adt/discovery" });
  assert.equal(res.status, 401);
});

test("reporter: bearer tokens and certificate passphrases are redacted", () => {
  const secrets = _internals.collectSecrets({
    A: { host: "https://h.example", auth: { type: "bearer", token: "eyJtoken-value" } },
    B: { host: "https://h2.example", user: "USR1", auth: { type: "certificate", passphrase: "pfx-pass" } },
  });
  const redact = _internals.makeRedactor(secrets);
  const out = redact("token eyJtoken-value and pfx-pass leaked");
  assert.ok(!out.includes("eyJtoken-value"));
  assert.ok(!out.includes("pfx-pass"));
});
