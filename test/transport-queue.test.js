import { test } from "node:test";
import assert from "node:assert/strict";

import { summarizeTpalog, tstampToIso, rcSeverity, describeHeader } from "../src/transport-queue.js";
import { register } from "../src/tools/transports.js";
import { sqlClient, ctxFor, parse } from "./helpers/fake-adt.js";

const step = (TARSYSTEM, TRSTEP, RETCODE, TRTIME) => ({
  TRKORR: "E4DK900850",
  TARSYSTEM,
  TRCLI: "300",
  TRSTEP,
  RETCODE,
  TRTIME,
  TRUSER: "DEV",
});

test("tstampToIso and rcSeverity", () => {
  assert.equal(tstampToIso("20261008100325"), "2026-10-08T10:03:25Z");
  assert.equal(tstampToIso(""), null);
  assert.equal(rcSeverity("0000"), "ok");
  assert.equal(rcSeverity("0004"), "warning");
  assert.equal(rcSeverity("0008"), "error");
  assert.equal(rcSeverity("0012"), "aborted");
  assert.equal(rcSeverity("x"), "unknown");
});

test("summarizeTpalog: export in DEV, forward into QAS buffer", () => {
  const targets = summarizeTpalog([
    step("E4Q", "<", "0000", "20260403112006"),
    step("E4D", "E", "0000", "20260403110000"),
  ]);
  const bySid = Object.fromEntries(targets.map((t) => [t.system, t]));
  assert.equal(bySid.E4D.status, "exported");
  assert.equal(bySid.E4D.steps[0].stepText, "Main export");
  assert.equal(bySid.E4Q.status, "in-import-queue");
  assert.equal(bySid.E4Q.lastAction, "2026-04-03T11:20:06Z");
});

test("summarizeTpalog: import status follows the worst return code", () => {
  const ok = summarizeTpalog([step("E4Q", "H", "0000", "1"), step("E4Q", "I", "0004", "2")]);
  assert.equal(ok[0].status, "imported");
  assert.equal(ok[0].maxRc, 4);
  const err = summarizeTpalog([step("E4Q", "I", "0008", "1")]);
  assert.equal(err[0].status, "imported-with-errors");
  const aborted = summarizeTpalog([step("E4Q", "A", "0012", "1")]);
  assert.equal(aborted[0].status, "import-aborted");
});

test("describeHeader decodes status and date", () => {
  assert.deepEqual(
    describeHeader({
      TRKORR: "E4DK984560",
      TRFUNCTION: "K",
      TRSTATUS: "R",
      TARSYSTEM: "E4Q",
      AS4USER: "DEV",
      AS4DATE: "20261008",
      AS4TIME: "100325",
      STRKORR: "",
    }),
    {
      transport: "E4DK984560",
      type: "K",
      status: "R",
      statusText: "Released",
      target: "E4Q",
      owner: "DEV",
      lastChanged: "2026-10-08",
      parent: undefined,
    }
  );
  assert.equal(describeHeader(undefined), null);
});

test("adt_transport_queue: reads each system of the route; an unreachable one is reported, not fatal", async () => {
  const dev = sqlClient([
    [/FROM e070/i, [{ TRKORR: "E4DK900850", TRFUNCTION: "K", TRSTATUS: "R", TARSYSTEM: "E4Q", AS4USER: "DEV", AS4DATE: "20260403", AS4TIME: "110000", STRKORR: "" }]],
    [/FROM e07t/i, [{ AS4TEXT: "Fleet transfer fix" }]],
    [/FROM tpalog/i, [step("E4D", "E", "0000", "20260403110000"), step("E4Q", "<", "0000", "20260403110100")]],
  ]);
  const qas = sqlClient([
    [/FROM e070/i, [{ TRKORR: "E4DK900850", TRFUNCTION: "K", TRSTATUS: "R", TARSYSTEM: "E4Q", AS4USER: "DEV", AS4DATE: "20260403", AS4TIME: "110000", STRKORR: "" }]],
    [/FROM tpalog/i, [step("E4Q", "I", "0004", "20260404090000")]],
  ]);
  const h = register(ctxFor({ DEV: dev, QAS: qas }));
  const out = parse(await h.adt_transport_queue({ transport: "e4dk900850", systems: ["DEV", "QAS", "PRD"] }));

  assert.equal(out.transport, "E4DK900850");
  assert.equal(out.systems.length, 3);
  const [d, q, p] = out.systems;
  assert.equal(d.description, "Fleet transfer fix");
  assert.equal(d.header.statusText, "Released");
  assert.deepEqual(d.targets.map((t) => [t.system, t.status]), [["E4D", "exported"], ["E4Q", "in-import-queue"]]);
  assert.equal(q.targets[0].status, "imported");
  assert.equal(p.system, "PRD");
  assert.match(p.error, /Unknown system/);
});

test("adt_transport_queue: a task is followed up to its request", async () => {
  const client = sqlClient([
    [/FROM e070/i, [{ TRKORR: "E4DK900851", TRFUNCTION: "S", TRSTATUS: "R", TARSYSTEM: "", AS4USER: "DEV", AS4DATE: "20260403", AS4TIME: "110000", STRKORR: "E4DK900850" }]],
    [/FROM tpalog WHERE trkorr = 'E4DK900850'/i, [step("E4D", "E", "0000", "1")]],
  ]);
  const out = parse(await register(ctxFor({ DEV: client })).adt_transport_queue({ transport: "E4DK900851" }));
  assert.equal(out.systems[0].request, "E4DK900850");
  assert.equal(out.systems[0].targets[0].status, "exported");
});

test("adt_transport_queue: rejects a malformed transport id before any SAP call", async () => {
  const client = sqlClient([]);
  const out = await register(ctxFor({ DEV: client })).adt_transport_queue({ transport: "E4DK' OR '1'='1" });
  assert.equal(out.isError, true);
  assert.equal(client.calls.length, 0);
});

test("adt_transport_queue: a TPALOG read failure keeps the header", async () => {
  const client = sqlClient([
    [/FROM e070/i, [{ TRKORR: "E4DK900850", TRSTATUS: "D", STRKORR: "" }]],
    [/FROM tpalog/i, 403],
  ]);
  const out = parse(await register(ctxFor({ DEV: client })).adt_transport_queue({ transport: "E4DK900850" }));
  assert.equal(out.systems[0].stage, "tpalog");
  assert.equal(out.systems[0].header.statusText, "Modifiable");
});
