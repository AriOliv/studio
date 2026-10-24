/**
 * Downstream Token Storage Implementation
 *
 * Handles CRUD operations for downstream MCP OAuth tokens.
 * Supports token caching and refresh for OAuth-enabled MCP connections.
 *
 * Tokens are keyed by (connection_id, user_id):
 *   - `userId = null`   → shared token (one per connection, used when the
 *                          connection's auth_mode is "shared")
 *   - `userId = <uuid>` → per-user token (one per (connection, user) pair,
 *                          used when auth_mode is "per_user")
 *
 * The two cases are enforced by partial unique indexes on the database
 * (see migration 170-zz-per-user-oauth).
 */

import { createHash } from "node:crypto";
import { type Kysely, sql } from "kysely";
import type { CredentialVault } from "../encryption/credential-vault";
import type { Database, DownstreamToken } from "./types";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";

/**
 * Hash `(connectionId, userId)` to a signed int64 for `pg_advisory_xact_lock`.
 * Shared and per-user grants of the same connection get different keys.
 */
function grantLockKey(connectionId: string, userId: string | null): bigint {
  return createHash("sha256")
    .update("downstream-token:")
    .update(connectionId)
    .update("\x00")
    .update(userId ?? "")
    .digest()
    .readBigInt64BE(0);
}

/**
 * Data for creating/updating a downstream token
 */
export interface DownstreamTokenData {
  connectionId: string;
  /**
   * Null (or omitted) for shared tokens; a user id for per-user tokens.
   * Optional so shared-token callers don't have to spell out `userId: null`.
   */
  userId?: string | null;
  accessToken: string;
  refreshToken: string | null;
  scope: string | null;
  expiresAt: Date | null;
  // Dynamic Client Registration info
  clientId: string | null;
  clientSecret: string | null;
  tokenEndpoint: string | null;
}

/**
 * Downstream Token Storage Implementation
 */
export class DownstreamTokenStorage {
  constructor(
    private db: Kysely<Database>,
    private vault: CredentialVault,
  ) {}

  async get(
    connectionId: string,
    userId: string | null = null,
  ): Promise<DownstreamToken | null> {
    const base = this.db
      .selectFrom("downstream_tokens")
      .selectAll()
      .where("connectionId", "=", connectionId);

    const query = userId
      ? base.where("userId", "=", userId)
      : base.where("userId", "is", null);

    const row = await query.executeTakeFirst();

    if (!row) return null;

    return decryptDownstreamTokenRow(this.vault, row);
  }

  async upsert(data: DownstreamTokenData): Promise<DownstreamToken> {
    const now = new Date().toISOString();

    // Encrypt sensitive fields
    const encryptedAccessToken = await this.vault.encrypt(data.accessToken);
    const encryptedRefreshToken = data.refreshToken
      ? await this.vault.encrypt(data.refreshToken)
      : null;
    const encryptedClientSecret = data.clientSecret
      ? await this.vault.encrypt(data.clientSecret)
      : null;
    const expiresAt = data.expiresAt?.toISOString() ?? null;

    const tokenUserId = data.userId ?? null;
    const updateSet = {
      accessToken: encryptedAccessToken,
      refreshToken: encryptedRefreshToken,
      scope: data.scope,
      expiresAt,
      clientId: data.clientId,
      clientSecret: encryptedClientSecret,
      tokenEndpoint: data.tokenEndpoint,
      updatedAt: now,
    };

    // Atomic upsert, race-free under concurrent calls. The conflict target is
    // the partial unique index for this token's scope (migration 170-zz):
    // one shared row per connection, one row per (connection, user) pair.
    const row = await this.db
      .insertInto("downstream_tokens")
      .values({
        id: generatePrefixedId("dtok"),
        connectionId: data.connectionId,
        userId: tokenUserId,
        ...updateSet,
        createdAt: now as unknown as string,
        updatedAt: now as unknown as string,
      })
      .onConflict((oc) =>
        tokenUserId
          ? oc
              .columns(["connectionId", "userId"])
              .where("userId", "is not", null)
              .doUpdateSet(updateSet)
          : oc
              .column("connectionId")
              .where("userId", "is", null)
              .doUpdateSet(updateSet),
      )
      .returning(["id", "createdAt"])
      .executeTakeFirstOrThrow();

    return {
      id: row.id,
      connectionId: data.connectionId,
      userId: tokenUserId,
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      scope: data.scope,
      expiresAt: data.expiresAt,
      createdAt: row.createdAt as unknown as string,
      updatedAt: now,
      clientId: data.clientId,
      clientSecret: data.clientSecret,
      tokenEndpoint: data.tokenEndpoint,
    };
  }

  async delete(
    connectionId: string,
    userId: string | null = null,
  ): Promise<void> {
    const base = this.db
      .deleteFrom("downstream_tokens")
      .where("connectionId", "=", connectionId);

    await (userId
      ? base.where("userId", "=", userId)
      : base.where("userId", "is", null)
    ).execute();
  }

  /**
   * Delete the row only if it still holds `expectedRefreshToken`. Returns
   * true when a row was deleted.
   *
   * Used after an `invalid_grant`: with rotating refresh tokens, that answer
   * can also mean "another process already redeemed this token and stored the
   * successor". Deleting unconditionally would wipe the fresh row and force
   * the member to reconnect; comparing first keeps the successor.
   */
  async deleteIfRefreshTokenMatches(
    connectionId: string,
    userId: string | null,
    expectedRefreshToken: string,
  ): Promise<boolean> {
    return await this.transactional(async (trx) => {
      const base = trx
        .selectFrom("downstream_tokens")
        .select(["id", "refreshToken"])
        .where("connectionId", "=", connectionId)
        .forUpdate();
      const row = await (userId
        ? base.where("userId", "=", userId)
        : base.where("userId", "is", null)
      ).executeTakeFirst();
      if (!row?.refreshToken) return false;
      let stored: string;
      try {
        stored = await this.vault.decrypt(row.refreshToken);
      } catch {
        // Undecryptable row (key rotation): it's useless either way.
        stored = expectedRefreshToken;
      }
      if (stored !== expectedRefreshToken) return false;
      await trx
        .deleteFrom("downstream_tokens")
        .where("id", "=", row.id)
        .execute();
      return true;
    });
  }

  /**
   * Serialize `fn` across every process of this deployment for one
   * (connection, user) grant. Postgres advisory lock, transaction-scoped: it
   * is released on commit, rollback or connection drop, so a crashed pod never
   * strands a grant. The callback receives a storage view bound to the lock's
   * transaction so its reads see what the previous holder committed.
   *
   * Needed because the upstream refresh_token is single-use and rotates: two
   * replicas redeeming the same token in parallel leaves the loser with
   * `invalid_grant` and, before this lock, with the winner's fresh row
   * deleted.
   */
  async withGrantLock<T>(
    connectionId: string,
    userId: string | null,
    fn: (store: DownstreamTokenStorage) => Promise<T>,
  ): Promise<T> {
    const key = grantLockKey(connectionId, userId);
    return await this.transactional(async (trx) => {
      await sql`select pg_advisory_xact_lock(${key}::bigint)`.execute(trx);
      return await fn(new DownstreamTokenStorage(trx, this.vault));
    });
  }

  /**
   * Run `fn` in a transaction, reusing the current one when this storage was
   * built on a transaction (Kysely rejects nested `transaction()` calls).
   */
  private transactional<T>(
    fn: (trx: Kysely<Database>) => Promise<T>,
  ): Promise<T> {
    if (this.db.isTransaction) return fn(this.db);
    return this.db.transaction().execute(fn);
  }

  /**
   * Delete every token attached to a connection (shared + all per-user
   * tokens). Used when a connection is removed.
   */
  async deleteByConnection(connectionId: string): Promise<void> {
    await this.db
      .deleteFrom("downstream_tokens")
      .where("connectionId", "=", connectionId)
      .execute();
  }

  /**
   * Check if token is expired or will expire within buffer time.
   *
   * Note: the default buffer is 0 (actual expiry). Callers that can refresh
   * should pass a buffer (e.g. 5 minutes) to refresh proactively.
   */
  isExpired(token: DownstreamToken, bufferMs: number = 0): boolean {
    if (!token.expiresAt) {
      // No expiry = never expires
      return false;
    }

    const expiresAt =
      token.expiresAt instanceof Date
        ? token.expiresAt
        : new Date(token.expiresAt);

    const expiryTime = expiresAt.getTime();
    if (Number.isNaN(expiryTime)) {
      // Fail-safe: if date is invalid, treat as expired
      return true;
    }

    return expiryTime - bufferMs < Date.now();
  }
}

/**
 * Row shape as read back from `downstream_tokens`, before decryption.
 */
export interface RawDownstreamTokenRow {
  id: string;
  connectionId: string;
  userId: string | null;
  accessToken: string;
  refreshToken: string | null;
  scope: string | null;
  expiresAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  clientId: string | null;
  clientSecret: string | null;
  tokenEndpoint: string | null;
}

/**
 * Decrypt sensitive fields from a database row. Corrupted ciphertext (a
 * tampered value, or a row encrypted under a vault key that has since been
 * rotated) makes AES-GCM's tag check throw — that must not crash the caller.
 * Callers already treat a missing row as "no cached token, go refresh/reconnect";
 * an undecryptable row degrades to the same outcome instead of a 500.
 * Exported standalone (no `this.db`) so it's unit-testable without Postgres.
 */
export async function decryptDownstreamTokenRow(
  vault: CredentialVault,
  row: RawDownstreamTokenRow,
): Promise<DownstreamToken | null> {
  try {
    const accessToken = await vault.decrypt(row.accessToken);
    const refreshToken = row.refreshToken
      ? await vault.decrypt(row.refreshToken)
      : null;
    const clientSecret = row.clientSecret
      ? await vault.decrypt(row.clientSecret)
      : null;

    return {
      id: row.id,
      connectionId: row.connectionId,
      userId: row.userId,
      accessToken,
      refreshToken,
      scope: row.scope,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      clientId: row.clientId,
      clientSecret,
      tokenEndpoint: row.tokenEndpoint,
    };
  } catch (error) {
    console.warn("[DownstreamToken] failed to decrypt token row", {
      connectionId: row.connectionId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
