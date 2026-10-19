import { describe, it, expect, vi, mock, beforeEach } from "bun:test";
import type { TokenRefreshResult } from "./refresh-access-token";
import type { DownstreamToken } from "../storage/types";
import type { DownstreamTokenStorage } from "../storage/downstream-token";

// Narrow justified mock per TESTING.md: refreshAccessToken makes a real HTTP call.
const mockRefreshAccessToken =
  vi.fn<(...args: unknown[]) => Promise<TokenRefreshResult>>();
mock.module("./refresh-access-token", () => ({
  refreshAccessToken: mockRefreshAccessToken,
}));

const { refreshAndStore, clearRefreshBackoff } = await import(
  "./token-refresh"
);

const baseToken: DownstreamToken = {
  id: "dtok_1",
  connectionId: "conn_persist_fail",
  userId: null,
  accessToken: "old-access",
  refreshToken: "refresh-1",
  scope: null,
  expiresAt: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
  clientId: "client-1",
  clientSecret: null,
  tokenEndpoint: "https://idp.example.com/token",
};

function fakeStorage(overrides: Partial<DownstreamTokenStorage>) {
  return {
    get: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    isExpired: vi.fn(),
    ...overrides,
  } as unknown as DownstreamTokenStorage;
}

beforeEach(() => {
  mockRefreshAccessToken.mockReset();
  clearRefreshBackoff();
});

describe("refreshAndStore — storage failures don't throw", () => {
  it("returns the freshly refreshed token instead of discarding it when persisting fails", async () => {
    mockRefreshAccessToken.mockResolvedValue({
      success: true,
      accessToken: "new-access",
      expiresIn: 3600,
    });
    const storage = fakeStorage({
      upsert: vi.fn().mockRejectedValue(new Error("db unavailable")),
    });

    await expect(refreshAndStore(baseToken, storage)).resolves.toBe(
      "new-access",
    );
  });

  it("returns null instead of rejecting when deleting a dead token fails", async () => {
    mockRefreshAccessToken.mockResolvedValue({
      success: false,
      permanent: true,
      error: "invalid_grant",
    });
    const storage = fakeStorage({
      delete: vi.fn().mockRejectedValue(new Error("db unavailable")),
    });

    await expect(refreshAndStore(baseToken, storage)).resolves.toBeNull();
  });

  it("stores a rejected expires_in as already-expired, not as never-expiring", async () => {
    mockRefreshAccessToken.mockResolvedValue({
      success: true,
      accessToken: "new-access",
      expiresInMalformed: true,
    });
    const upsert = vi.fn().mockResolvedValue(undefined);
    const storage = fakeStorage({ upsert });

    await refreshAndStore(baseToken, storage);

    const expiresAt = upsert.mock.calls[0]?.[0].expiresAt as Date;
    expect(expiresAt).toBeInstanceOf(Date);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe("refreshAndStore — per-user single-flight", () => {
  // Two members of one per-user connection share its connectionId. Their
  // refreshes must not collapse into one in-flight promise: that would hand
  // one member the other's access token.
  it("never resolves one member's refresh with another member's token", async () => {
    const releases: Array<() => void> = [];
    mockRefreshAccessToken.mockImplementation(async (...args: unknown[]) => {
      const token = args[0] as DownstreamToken;
      await new Promise<void>((resolve) => releases.push(resolve));
      return {
        success: true,
        accessToken: `new-for-${token.userId}`,
        expiresIn: 3600,
      };
    });
    const storage = fakeStorage({ upsert: vi.fn().mockResolvedValue({}) });
    const memberA = { ...baseToken, userId: "user_a", refreshToken: "ra" };
    const memberB = { ...baseToken, userId: "user_b", refreshToken: "rb" };

    const a = refreshAndStore(memberA, storage);
    const b = refreshAndStore(memberB, storage);
    // Both are in flight at once: each must have made its own IdP call.
    expect(mockRefreshAccessToken).toHaveBeenCalledTimes(2);
    for (const release of releases) release();

    await expect(a).resolves.toBe("new-for-user_a");
    await expect(b).resolves.toBe("new-for-user_b");
  });

  it("still collapses concurrent refreshes of the same member", async () => {
    let release: () => void = () => {};
    mockRefreshAccessToken.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { success: true, accessToken: "once", expiresIn: 3600 };
    });
    const storage = fakeStorage({ upsert: vi.fn().mockResolvedValue({}) });
    const member = { ...baseToken, userId: "user_a" };

    const first = refreshAndStore(member, storage);
    const second = refreshAndStore(member, storage);
    expect(mockRefreshAccessToken).toHaveBeenCalledTimes(1);
    release();

    await expect(first).resolves.toBe("once");
    await expect(second).resolves.toBe("once");
  });

  it("clears every member's backoff when the connection's is cleared", async () => {
    mockRefreshAccessToken.mockResolvedValue({ success: false });
    const storage = fakeStorage({});
    const member = { ...baseToken, userId: "user_a" };

    await refreshAndStore(member, storage);
    // Inside the window: no second IdP call.
    await refreshAndStore(member, storage);
    expect(mockRefreshAccessToken).toHaveBeenCalledTimes(1);

    clearRefreshBackoff(baseToken.connectionId);
    await refreshAndStore(member, storage);
    expect(mockRefreshAccessToken).toHaveBeenCalledTimes(2);
  });
});
