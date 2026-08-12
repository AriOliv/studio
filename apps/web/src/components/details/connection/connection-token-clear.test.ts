import { describe, expect, it } from "bun:test";
import { formValuesToConnectionUpdate } from "./index";
import type { ConnectionFormData } from "./settings-tab/schema";

const baseForm = (over: Partial<ConnectionFormData>): ConnectionFormData => ({
  title: "Conn",
  ui_type: "HTTP",
  connection_url: "https://example.com/mcp",
  connection_token: null,
  auth_mode: "shared",
  ...over,
});

describe("formValuesToConnectionUpdate", () => {
  it("omits connection_token when the field was never touched", () => {
    const update = formValuesToConnectionUpdate(baseForm({}));
    expect("connection_token" in update).toBe(false);
  });

  it("sends an explicit null when the user clears the token", () => {
    const update = formValuesToConnectionUpdate(
      baseForm({ connection_token: "" }),
    );
    expect(update.connection_token).toBeNull();
  });

  it("sends the new token when the user replaces it", () => {
    const update = formValuesToConnectionUpdate(
      baseForm({ connection_token: "new-token" }),
    );
    expect(update.connection_token).toBe("new-token");
  });
});

describe("formValuesToConnectionUpdate auth_mode", () => {
  // The form hydrates auth_mode from a cached connection that can briefly
  // disagree with the DB, so saving an unrelated field must not write it.
  it("omits auth_mode when the toggle was never touched", () => {
    const update = formValuesToConnectionUpdate(
      baseForm({ auth_mode: "shared" }),
    );
    expect("auth_mode" in update).toBe(false);
  });

  it("sends auth_mode when the toggle was flipped", () => {
    const update = formValuesToConnectionUpdate(
      baseForm({ auth_mode: "per_user" }),
      { auth_mode: true },
    );
    expect(update.auth_mode).toBe("per_user");
  });
});
