/**
 * Built-in Role Definitions
 *
 * Separated to avoid circular dependencies between auth and context-factory modules.
 */

/**
 * Built-in roles that have full access bypass at the platform layer.
 *
 * "user" is the Better Auth admin-plugin default for every fresh signup.
 * It is not an org admin role and must not bypass permission checks. Org
 * admin behavior lives in ADMIN_ROLES below.
 */
export const BUILTIN_ROLES = ["owner", "admin"] as const;

export type BuiltinRole = (typeof BUILTIN_ROLES)[number];

/**
 * Roles that have admin privileges
 */
export const ADMIN_ROLES: BuiltinRole[] = ["owner", "admin"];
