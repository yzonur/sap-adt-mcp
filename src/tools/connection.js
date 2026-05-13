import { jsonResult } from "../result.js";

export const tools = [
  {
    name: "adt_list_systems",
    description:
      "List configured SAP systems available for ADT calls, the default system, and read-only flags.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "adt_ping",
    description:
      "Ping a configured SAP system by calling the ADT discovery endpoint. Use to verify credentials and network reachability.",
    inputSchema: {
      type: "object",
      properties: {
        system: { type: "string", description: "System name. Omit for default." },
      },
    },
  },
];

export function register({ getClient, config }) {
  return {
    adt_list_systems: async () =>
      jsonResult({
        defaultSystem: config.defaultSystem ?? null,
        globalReadOnly: config.readOnly === true,
        systems: Object.entries(config.systems).map(([n, p]) => ({
          name: n,
          host: p.host,
          client: p.client,
          user: p.user,
          readOnly: p.readOnly === true,
          rejectUnauthorized: p.rejectUnauthorized,
          isDefault: n === config.defaultSystem,
        })),
      }),

    adt_ping: async (args) => {
      const { client, name: sys } = getClient(args.system);
      const res = await client.request({ path: "/sap/bc/adt/discovery" });
      return jsonResult({ system: sys, status: res.status, ok: res.ok }, !res.ok);
    },
  };
}
