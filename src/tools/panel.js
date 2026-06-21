import { exec } from "node:child_process";
import { jsonResult } from "../result.js";
import {
  ensurePanelStarted,
  stopPanel,
  isPanelRunning,
  getPanelUrl,
} from "../panel.js";

// Best-effort "open this URL in the user's browser". Never throws.
function openInBrowser(url) {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start \"\""
        : "xdg-open";
  return new Promise((resolve) => {
    try {
      exec(`${cmd} "${url}"`, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}

export const tools = [
  {
    name: "adt_open_panel",
    description:
      "Open the local, read-only SAP control panel: an HTML page with buttons for the read-only tools (search, grep source, get source, read table, ATC, where-used, packages, transports, dumps, inactive objects). Returns the URL to open. The panel is served from inside THIS MCP process, so it works only while this session keeps the MCP connected and dies when the session ends. Bound to 127.0.0.1, gated by a per-boot random token, read-only tools only — no write tool is reachable. By default also opens the URL in the local default browser.",
    inputSchema: {
      type: "object",
      properties: {
        open: {
          type: "boolean",
          description:
            "Also open the URL in the local default browser. Default true. Set false to just return the URL.",
        },
      },
    },
  },
  {
    name: "adt_close_panel",
    description:
      "Stop the local control panel started by adt_open_panel. (It also stops on its own when this MCP session ends.)",
    inputSchema: { type: "object", properties: {} },
  },
];

export function register() {
  return {
    adt_open_panel: async (args = {}) => {
      let info;
      try {
        info = await ensurePanelStarted();
      } catch (err) {
        return jsonResult(
          {
            ok: false,
            error: `Could not start panel: ${err.message}`,
          },
          true
        );
      }
      const wantOpen = args.open !== false;
      const browserOpened = wantOpen ? await openInBrowser(info.url) : false;
      return jsonResult({
        ok: true,
        url: info.url,
        alreadyRunning: info.alreadyRunning,
        browserOpened,
        readOnly: true,
        note:
          "Open this URL in a browser. The panel lives inside this MCP process — " +
          "it closes automatically when the session ends. Read-only tools only.",
      });
    },

    adt_close_panel: async () => {
      const wasRunning = isPanelRunning();
      const stoppedUrl = stopPanel();
      return jsonResult({
        ok: true,
        wasRunning,
        stoppedUrl,
        stillRunning: isPanelRunning(),
        currentUrl: getPanelUrl(),
      });
    },
  };
}
