import { BASIC_USAGE_TOOLS } from "../tools/registry-metadata";
import { ADMIN_ROLES } from "./roles";

/**
 * Member's allowed management-MCP surface. Keep in sync with the `member`
 * role's `self` permissions in auth/index.ts.
 */
export const MEMBER_SELF_TOOLS = [
  "COLLECTION_CONNECTIONS_LIST",
  "COLLECTION_CONNECTIONS_GET",
  "COLLECTION_VIRTUAL_MCP_LIST",
  "COLLECTION_VIRTUAL_MCP_GET",
  "ORGANIZATION_LIST",
  "ORGANIZATION_GET",
  "ORGANIZATION_MEMBER_LIST",
  "API_KEY_CREATE",
  "API_KEY_LIST",
] as const;

export type AllowedTools =
  | { mode: "all" }
  | { mode: "explicit"; names: Set<string> };

export function getAllowedToolsForRole(
  role: string | undefined | null,
): AllowedTools {
  if (!role) {
    return { mode: "explicit", names: new Set() };
  }

  if (
    ADMIN_ROLES.includes(role as (typeof ADMIN_ROLES)[number]) ||
    role === "user"
  ) {
    return { mode: "all" };
  }

  if (role === "member") {
    return {
      mode: "explicit",
      names: new Set<string>([...MEMBER_SELF_TOOLS, ...BASIC_USAGE_TOOLS]),
    };
  }

  return { mode: "explicit", names: new Set<string>(BASIC_USAGE_TOOLS) };
}
