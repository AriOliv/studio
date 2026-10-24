/**
 * Regression: the MCP SDK parses tool arguments with the tool's zod schema and
 * hands the handler the PARSED object. With `auth_mode` carrying a default in
 * the update schema, `data: { status }` reached the handler as
 * `{ status, auth_mode: "shared" }` and demoted every per_user connection.
 *
 * Drives a real McpServer + Client over an in-memory transport with the exact
 * schema COLLECTION_CONNECTIONS_UPDATE registers, so the test fails if either
 * the schema or the SDK's parsing behavior regresses.
 */
import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ConnectionUpdateDataSchema } from "./schema";

async function roundTrip(data: Record<string, unknown>) {
  let received: unknown;
  const server = new McpServer({ name: "t", version: "0" });
  server.registerTool(
    "COLLECTION_CONNECTIONS_UPDATE",
    {
      inputSchema: z.object({
        id: z.string(),
        data: ConnectionUpdateDataSchema,
      }),
    },
    async (input) => {
      received = input.data;
      return { content: [{ type: "text", text: "ok" }] };
    },
  );
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "c", version: "0" });
  await client.connect(ct);
  await client.callTool({
    name: "COLLECTION_CONNECTIONS_UPDATE",
    arguments: { id: "conn_x", data },
  });
  await client.close();
  return received as Record<string, unknown>;
}

describe("COLLECTION_CONNECTIONS_UPDATE input through the MCP SDK", () => {
  it("a status-only update does not carry auth_mode", async () => {
    expect(await roundTrip({ status: "inactive" })).toEqual({
      status: "inactive",
    });
  });

  it("an empty update (post-OAuth tools refetch) does not carry auth_mode", async () => {
    expect(await roundTrip({})).toEqual({});
  });

  it("an explicit auth_mode is preserved", async () => {
    expect(await roundTrip({ auth_mode: "per_user" })).toEqual({
      auth_mode: "per_user",
    });
  });
});
