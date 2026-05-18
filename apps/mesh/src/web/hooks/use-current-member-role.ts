import { useOrgAuthClient } from "@/web/hooks/use-org-auth-client";
import { authClient } from "@/web/lib/auth-client";
import { KEYS } from "@/web/lib/query-keys";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useQuery } from "@tanstack/react-query";

/**
 * Resolve the current viewer's role within the active org.
 *
 * Components consume permission booleans instead of comparing role strings.
 * A null role is treated as restrictive by every boolean below.
 */
export function useCurrentMemberRole() {
  const { data: session } = authClient.useSession();
  const { locator } = useProjectContext();
  const orgAuth = useOrgAuthClient();
  const { data: membersData } = useQuery({
    queryKey: KEYS.members(locator),
    queryFn: () => orgAuth.organization.listMembers(),
  });

  const members = (membersData?.data?.members ?? []) as Array<{
    userId: string;
    role: string;
  }>;
  const me = members.find((member) => member.userId === session?.user?.id);
  const role = me?.role ?? null;

  const isOwner = role === "owner";
  const isAdmin = role === "admin";
  const isMember = role === "member";
  const isAdminOrOwner = isOwner || isAdmin;

  return {
    userId: session?.user?.id ?? null,
    role,
    isOwner,
    isAdmin,
    isMember,
    isAdminOrOwner,
    canManageOrg: isAdminOrOwner,
    canManageConnections: isAdminOrOwner,
    canManageVirtualMcps: isAdminOrOwner,
    canManageMembers: isAdminOrOwner,
    canEditRoles: isAdminOrOwner,
    canManageAIProviders: isAdminOrOwner,
    canConnectOwnAccount: !!role,
  };
}
