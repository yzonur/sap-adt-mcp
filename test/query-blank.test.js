// Regression for #68: a whitespace-only transport ("transport": " ") reached the
// CTS backend as corrNr=%20 and 500'd adt_set_source. #buildUrl now drops
// null/undefined/blank query values, so no corrNr-bearing tool can emit one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgent, setGlobalDispatcher } from "undici";
import { AdtClient } from "../src/adt-client.js";

function makeClient() {
  return new AdtClient({
    host: "https://sap.example.com:44300",
    user: "DEVELOPER",
    password: "x",
    client: "100",
  });
}

test("blank corrNr is dropped from the query; real params survive", async () => {
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);

  let seenPath;
  mock
    .get("https://sap.example.com:44300")
    .intercept({ method: "GET", path: /\/sap\/bc\/adt\/foo/ })
    .reply((req) => {
      seenPath = req.path;
      return { statusCode: 200, data: "ok" };
    });

  await makeClient().request({
    method: "GET",
    path: "/sap/bc/adt/foo",
    query: { corrNr: " ", lockHandle: "H123" },
  });

  assert.ok(!/corrNr/.test(seenPath), `blank corrNr leaked: ${seenPath}`);
  assert.match(seenPath, /lockHandle=H123/, "real param must survive");
  await mock.close();
});

test("empty-string and undefined query values are dropped too", async () => {
  const mock = new MockAgent();
  mock.disableNetConnect();
  setGlobalDispatcher(mock);

  let seenPath;
  mock
    .get("https://sap.example.com:44300")
    .intercept({ method: "GET", path: /\/sap\/bc\/adt\/bar/ })
    .reply((req) => {
      seenPath = req.path;
      return { statusCode: 200, data: "ok" };
    });

  await makeClient().request({
    method: "GET",
    path: "/sap/bc/adt/bar",
    query: { corrNr: "", version: undefined, keep: "yes" },
  });

  assert.ok(!/corrNr/.test(seenPath), `empty corrNr leaked: ${seenPath}`);
  assert.ok(!/version/.test(seenPath), `undefined version leaked: ${seenPath}`);
  assert.match(seenPath, /keep=yes/, "real param must survive");
  await mock.close();
});
