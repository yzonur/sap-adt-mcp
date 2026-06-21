---
description: SAP ADT read-only kontrol panelini aç (tarayıcıda)
---

Call the `adt_open_panel` MCP tool (from the sap-adt-mcp server) to start the
local read-only control panel and open it in the browser.

- If the user passed `close` / `kapat` as an argument, call `adt_close_panel`
  instead and confirm it stopped.
- If the user passed `url` / `nourl`, call `adt_open_panel` with `{ "open": false }`
  and just report the URL without opening a browser.
- Otherwise call `adt_open_panel` with no arguments (opens the browser).

After the tool returns, tell the user the panel URL in one line and remind them
it stays up only while this session keeps the MCP connected. If the tool errors
because the sap-adt-mcp MCP isn't connected in this session, say so plainly.

Arguments (optional): $ARGUMENTS
