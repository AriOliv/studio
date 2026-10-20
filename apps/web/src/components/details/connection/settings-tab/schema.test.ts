import { expect, test } from "bun:test";
import { configurationScopesFor, connectionFormSchema } from "./schema";

// The form always hydrates auth_mode (index.tsx defaults it to "shared"), so
// every fixture carries it — otherwise a rejection could come from the missing
// field instead of the property under test.
const base = {
  title: "My connection",
  ui_type: "HTTP" as const,
  auth_mode: "shared" as const,
};

test("rejects a non-URL connection_url for HTTP connections", () => {
  const result = connectionFormSchema.safeParse({
    ...base,
    connection_url: "not-a-url",
  });
  expect(result.success).toBe(false);
});

test("accepts a well-formed connection_url", () => {
  const result = connectionFormSchema.safeParse({
    ...base,
    connection_url: "https://example.com/mcp",
  });
  expect(result.success).toBe(true);
});

test("does not require a URL shape for non-HTTP ui_types", () => {
  const result = connectionFormSchema.safeParse({
    title: "My command",
    ui_type: "STDIO",
    stdio_command: "node server.js",
    auth_mode: "shared",
  });
  expect(result.success).toBe(true);
});

test("requires auth_mode to be shared or per_user", () => {
  const ok = { ...base, connection_url: "https://example.com/mcp" };
  expect(
    connectionFormSchema.safeParse({ ...ok, auth_mode: "per_user" }).success,
  ).toBe(true);
  expect(
    connectionFormSchema.safeParse({ ...ok, auth_mode: "everyone" }).success,
  ).toBe(false);
});

test("adds a declared scope once its binding is set", () => {
  const declared = ["VTEX::credential:configuration:read"];
  expect(configurationScopesFor([], declared, {})).toEqual([]);
  expect(
    configurationScopesFor([], declared, {
      VTEX: { __type: "vtex", value: "conn_1" },
    }),
  ).toEqual(declared);
});

test("keeps saved scopes and does not duplicate them", () => {
  expect(
    configurationScopesFor(
      ["A::read", "B::write"],
      ["B::write", "C.nested::read"],
      { A: 1, B: 2, C: { nested: true } },
    ),
  ).toEqual(["A::read", "B::write", "C.nested::read"]);
});
