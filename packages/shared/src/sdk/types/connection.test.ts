import { describe, expect, it } from "bun:test";
import {
  ConnectionCreateDataSchema,
  ConnectionEntitySchema,
  ConnectionUpdateDataSchema,
} from "./connection";

describe("ConnectionUpdateDataSchema", () => {
  it("does not inject auth_mode when the update omits it", () => {
    // Regression: `.partial()` preserved the entity's `.default("shared")`, so
    // a status toggle or the post-OAuth `update({ data: {} })` demoted every
    // per_user connection back to shared on the server side.
    expect(ConnectionUpdateDataSchema.parse({ status: "inactive" })).toEqual({
      status: "inactive",
    });
    expect(ConnectionUpdateDataSchema.parse({})).toEqual({});
  });

  it("keeps auth_mode when the caller sends it", () => {
    expect(ConnectionUpdateDataSchema.parse({ auth_mode: "per_user" })).toEqual(
      { auth_mode: "per_user" },
    );
  });

  it("rejects an unknown auth_mode", () => {
    expect(
      ConnectionUpdateDataSchema.safeParse({ auth_mode: "everyone" }).success,
    ).toBe(false);
  });

  it("entity schema still defaults auth_mode to shared for reads", () => {
    const parsed = ConnectionEntitySchema.pick({ auth_mode: true }).parse({});
    expect(parsed.auth_mode).toBe("shared");
  });
});

function baseEntity(overrides: Record<string, unknown> = {}) {
  return {
    id: "conn_1",
    title: "Test connection",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: "user_1",
    organization_id: "org_1",
    description: null,
    icon: null,
    app_name: null,
    app_id: null,
    connection_type: "HTTP" as const,
    connection_url: "https://example.com",
    connection_token: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    configuration_scopes: null,
    metadata: null,
    tools: null,
    bindings: null,
    status: "active" as const,
    ...overrides,
  };
}

describe("ConnectionEntitySchema JSON field caps", () => {
  it("accepts metadata/configuration_state within the size cap", () => {
    const result = ConnectionEntitySchema.safeParse(
      baseEntity({ metadata: { foo: "bar" }, configuration_state: { a: 1 } }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects an oversized metadata blob", () => {
    const huge = { blob: "x".repeat(300 * 1024) };
    const result = ConnectionEntitySchema.safeParse(
      baseEntity({ metadata: huge }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects an oversized configuration_state blob", () => {
    const huge = { blob: "x".repeat(300 * 1024) };
    const result = ConnectionEntitySchema.safeParse(
      baseEntity({ configuration_state: huge }),
    );
    expect(result.success).toBe(false);
  });

  it("still rejects an oversized metadata blob on the create schema", () => {
    const huge = { blob: "x".repeat(300 * 1024) };
    const result = ConnectionCreateDataSchema.safeParse({
      title: "Test",
      connection_type: "HTTP",
      metadata: huge,
    });
    expect(result.success).toBe(false);
  });
});
