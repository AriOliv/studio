import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "kysely";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../database/test-db-pg";
import type { StudioDatabase } from "../database";
import { CredentialVault } from "../encryption/credential-vault";
import {
  DownstreamTokenStorage,
  type DownstreamTokenData,
} from "./downstream-token";

describe("DownstreamTokenStorage", () => {
  let database: StudioDatabase;
  let storage: DownstreamTokenStorage;

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);

    // Create test connections required by FK constraints
    const now = new Date().toISOString();
    for (const connId of ["c1", "conn_atomic", "conn_dual", "conn_iso"]) {
      await sql`
        INSERT INTO connections (id, organization_id, created_by, title, connection_type, connection_url, status, created_at, updated_at)
        VALUES (${connId}, 'org_test', 'user_test', ${connId}, 'HTTP', 'https://test.com', 'active', ${now}, ${now})
        ON CONFLICT (id) DO NOTHING
      `.execute(database.db);
    }

    const vault = new CredentialVault(CredentialVault.generateKey());
    storage = new DownstreamTokenStorage(database.db, vault);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("should fail-safe invalid expiration date as expired", async () => {
    const token = {
      id: "test",
      connectionId: "c1",
      userId: null,
      accessToken: "at",
      refreshToken: null,
      scope: null,
      expiresAt: "invalid-date-string", // Invalid date
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      clientId: null,
      clientSecret: null,
      tokenEndpoint: null,
    };

    // Before fix: new Date("invalid").getTime() is NaN. NaN < Date.now() is false.
    // After fix: should return true.
    expect(storage.isExpired(token)).toBe(true);
  });

  it("should not treat short-lived tokens as expired unless buffer is applied", async () => {
    const token = {
      id: "test",
      connectionId: "c1",
      userId: null,
      accessToken: "at",
      refreshToken: null,
      scope: null,
      expiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(), // 2 min
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      clientId: null,
      clientSecret: null,
      tokenEndpoint: null,
    };

    // Default buffer=0 => not expired yet
    expect(storage.isExpired(token)).toBe(false);
    // With 5 min buffer => considered expired (for proactive refresh flows)
    expect(storage.isExpired(token, 5 * 60 * 1000)).toBe(true);
  });

  it("should upsert shared token atomically", async () => {
    const data: DownstreamTokenData = {
      connectionId: "conn_atomic",
      userId: null,
      accessToken: "access_1",
      refreshToken: "refresh_1",
      scope: "scope_1",
      expiresAt: new Date(Date.now() + 3600000),
      clientId: "client_1",
      clientSecret: "secret_1",
      tokenEndpoint: "https://example.com/token",
    };

    // First insert
    const t1 = await storage.upsert(data);
    expect(t1.accessToken).toBe("access_1");
    expect(t1.clientId).toBe("client_1");
    expect(t1.userId).toBeNull();

    // Update
    const data2 = { ...data, accessToken: "access_2", clientId: "client_2" };
    const t2 = await storage.upsert(data2);

    expect(t2.id).toBe(t1.id); // Should update same record
    expect(t2.accessToken).toBe("access_2");
    expect(t2.clientId).toBe("client_2");

    // Check DB count for this connection — still one shared row
    const count = await database.db
      .selectFrom("downstream_tokens")
      .select(database.db.fn.count("id").as("c"))
      .where("connectionId", "=", "conn_atomic")
      .executeTakeFirst();
    expect(Number(count?.c)).toBe(1);
  });

  it("should isolate per-user tokens for the same connection", async () => {
    const base: Omit<DownstreamTokenData, "userId" | "accessToken"> = {
      connectionId: "conn_iso",
      refreshToken: null,
      scope: null,
      expiresAt: null,
      clientId: null,
      clientSecret: null,
      tokenEndpoint: null,
    };

    await storage.upsert({ ...base, userId: "user_1", accessToken: "tok-1" });
    await storage.upsert({ ...base, userId: "user_123", accessToken: "tok-2" });

    const t1 = await storage.get("conn_iso", "user_1");
    const t2 = await storage.get("conn_iso", "user_123");

    expect(t1?.accessToken).toBe("tok-1");
    expect(t2?.accessToken).toBe("tok-2");

    // Looking up a user that never authorised returns null
    expect(await storage.get("conn_iso", "user_test")).toBeNull();
    // Shared lookup returns null because we only stored per-user rows
    expect(await storage.get("conn_iso", null)).toBeNull();

    // Per-user delete leaves the other user's token intact
    await storage.delete("conn_iso", "user_1");
    expect(await storage.get("conn_iso", "user_1")).toBeNull();
    expect(await storage.get("conn_iso", "user_123")).not.toBeNull();

    // deleteByConnection wipes both
    await storage.deleteByConnection("conn_iso");
    expect(await storage.get("conn_iso", "user_123")).toBeNull();
  });

  it("should allow shared and per-user tokens to coexist for the same connection", async () => {
    const base: Omit<DownstreamTokenData, "userId" | "accessToken"> = {
      connectionId: "conn_dual",
      refreshToken: null,
      scope: null,
      expiresAt: null,
      clientId: null,
      clientSecret: null,
      tokenEndpoint: null,
    };

    await storage.upsert({ ...base, userId: null, accessToken: "shared" });
    await storage.upsert({ ...base, userId: "user_1", accessToken: "ceo" });

    expect((await storage.get("conn_dual", null))?.accessToken).toBe("shared");
    expect((await storage.get("conn_dual", "user_1"))?.accessToken).toBe("ceo");

    // Two rows total: one shared, one per-user.
    const count = await database.db
      .selectFrom("downstream_tokens")
      .select(database.db.fn.count("id").as("c"))
      .where("connectionId", "=", "conn_dual")
      .executeTakeFirst();
    expect(Number(count?.c)).toBe(2);
  });
});
