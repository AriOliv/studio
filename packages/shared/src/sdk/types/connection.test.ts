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
    expect(ConnectionUpdateDataSchema.parse({ auth_mode: "shared" })).toEqual({
      auth_mode: "shared",
    });
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

  it("create schema never accepts auth_mode (column default applies)", () => {
    const shape = ConnectionCreateDataSchema.shape as Record<string, unknown>;
    expect("auth_mode" in shape).toBe(false);
  });
});
