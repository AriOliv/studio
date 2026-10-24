/**
 * The OAuth proxy persists the downstream token it just exchanged so the
 * browser doesn't have to post it back. That persistence must honor the
 * connection's `auth_mode`: on a `per_user` connection the token belongs to
 * the member who authorized, so it goes in that member's row, never in the
 * shared row (which `headers.ts` would otherwise hand to every other member,
 * or ignore entirely in per_user mode — both wrong).
 *
 * Real Postgres: the partial unique indexes that separate shared from
 * per-user rows live in migration 171 and an in-memory fake would not
 * exercise them.
 */
process.env.ENCRYPTION_KEY ??= Buffer.from("0".repeat(32)).toString("base64");

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { sql } from "kysely";
import { auth } from "../auth";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import type { StudioDatabase } from "../database";
import { getSettings, setGlobalSettings } from "../settings";
import { createApp } from "./app";

if (!getSettings().encryptionKey) {
  setGlobalSettings({
    ...getSettings(),
    encryptionKey: process.env.ENCRYPTION_KEY!,
  });
}

function mockApiKey(userId: string, orgId: string, orgSlug: string) {
  vi.spyOn(auth.api, "verifyApiKey").mockResolvedValue({
    valid: true,
    error: null,
    key: {
      id: "test-key-id",
      name: "Test API Key",
      userId,
      permissions: undefined,
      metadata: {
        organization: { id: orgId, slug: orgSlug, name: orgSlug },
      },
    },
  } as never);
}

/** Origin AS: metadata + a token endpoint that always grants. */
function mockOrigin() {
  return vi.spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("oauth-protected-resource")) {
      return new Response("not found", { status: 404 });
    }
    if (url.includes("oauth-authorization-server")) {
      return new Response(
        JSON.stringify({
          issuer: "https://example.test",
          authorization_endpoint: "https://example.test/authorize",
          token_endpoint: "https://example.test/token",
          registration_endpoint: "https://example.test/register",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url === "https://example.test/token" && method === "POST") {
      return new Response(
        JSON.stringify({
          access_token: "at_from_origin",
          refresh_token: "rt_from_origin",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch);
}

async function exchange(
  app: Awaited<ReturnType<typeof createApp>>,
  connectionId: string,
) {
  return app.fetch(
    new Request(
      `http://studio.localhost/api/org_1/oauth-proxy/${connectionId}/token`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "abc",
          client_id: "client_xyz",
          redirect_uri: "http://studio.localhost/oauth/callback",
        }).toString(),
      },
    ),
  );
}

describe("oauth-proxy token persistence honors auth_mode", () => {
  let database: StudioDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
      VALUES ('mem_1', 'user_1', 'org_1', 'member', ${now}),
             ('mem_123', 'user_123', 'org_1', 'member', ${now})
      ON CONFLICT (id) DO NOTHING
    `.execute(database.db);
    for (const [id, authMode] of [
      ["conn_shared", "shared"],
      ["conn_peruser", "per_user"],
    ] as const) {
      await database.db
        .insertInto("connections")
        .values({
          id,
          organization_id: "org_1",
          created_by: "user_1",
          title: id,
          connection_type: "HTTP",
          connection_url: "https://example.test/mcp",
          status: "active",
          pinned: false,
          auth_mode: authMode,
          created_at: now,
          updated_at: now,
        })
        .execute();
    }
    app = await createApp({ database, disableNats: true });
    vi.spyOn(auth.api, "getMcpSession").mockResolvedValue(null);
    mockApiKey("user_1", "org_1", "org_1");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.shutdown();
    if (database) await closeTestPgDatabase(database);
  });

  async function rows(connectionId: string) {
    return database.db
      .selectFrom("downstream_tokens")
      .select(["userId"])
      .where("connectionId", "=", connectionId)
      .orderBy("userId")
      .execute();
  }

  it("per_user: stores the exchanged token under the caller, not the shared row", async () => {
    const fetchSpy = mockOrigin();
    try {
      const res = await exchange(app, "conn_peruser");
      expect(res.status).toBe(200);
      expect(await rows("conn_peruser")).toEqual([{ userId: "user_1" }]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("shared: stores the exchanged token in the shared row", async () => {
    const fetchSpy = mockOrigin();
    try {
      const res = await exchange(app, "conn_shared");
      expect(res.status).toBe(200);
      expect(await rows("conn_shared")).toEqual([{ userId: null }]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("per_user: two members authorizing keep separate rows and no shared row", async () => {
    const fetchSpy = mockOrigin();
    try {
      expect((await exchange(app, "conn_peruser")).status).toBe(200);
      mockApiKey("user_123", "org_1", "org_1");
      expect((await exchange(app, "conn_peruser")).status).toBe(200);
      expect(await rows("conn_peruser")).toEqual([
        { userId: "user_1" },
        { userId: "user_123" },
      ]);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
