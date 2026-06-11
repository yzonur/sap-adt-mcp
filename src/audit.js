// Local audit trail of every write the MCP server performs against SAP.
//
// Enterprise question #1 about AI-with-write-access is "what exactly did it
// change?". This module answers it with an append-only JSONL file: one line per
// unsafe-method ADT request (POST/PUT/DELETE/PATCH that isn't a whitelisted
// read-only query), plus blocked read-only violations. Reads are not logged —
// the file stays small and answers "what changed", not "what was seen".
//
// The log is local-only: nothing is sent anywhere. Disable with
// "audit": { "enabled": false } in config or SAP_ADT_MCP_AUDIT=0.

import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

// Carries { tool } across a tool handler's async calls, so client-level audit
// entries can name the MCP tool that triggered the write even when one handler
// makes several requests (lock → PUT → unlock).
export const toolContext = new AsyncLocalStorage();

export function createAuditLog(config) {
  const a = config.audit ?? {};
  const enabled = a.enabled !== false;
  const file = a.path;
  let dirReady = false;
  let warned = false;

  function record(entry) {
    if (!enabled || !file) return;
    try {
      if (!dirReady) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        dirReady = true;
      }
      const tool = toolContext.getStore()?.tool;
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        ...(tool ? { tool } : {}),
        ...entry,
      });
      fs.appendFileSync(file, line + "\n");
    } catch (err) {
      // Auditing must never break the actual work — warn once and move on.
      if (!warned) {
        warned = true;
        process.stderr.write(
          `[sap-adt-mcp] audit log write failed (${err.message}) — continuing without audit\n`
        );
      }
    }
  }

  return { enabled, path: file, record };
}
