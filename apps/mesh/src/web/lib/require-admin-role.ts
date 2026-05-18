import { redirect } from "@tanstack/react-router";
import { toast } from "sonner";
import { authClient } from "@/web/lib/auth-client";

export async function requireAdminRole(params: { org: string }) {
  const session = await authClient.getSession();
  const user = session?.data?.user;
  if (!user) {
    throw redirect({ to: "/login" });
  }

  const { data: orgs } = await authClient.organization.list();
  const organizationId = (orgs ?? []).find(
    (o: { slug: string; id: string }) => o.slug === params.org,
  )?.id;
  if (!organizationId) {
    toast.error("You don't have access to this page.");
    throw redirect({ to: "/$org", params: { org: params.org } });
  }

  // Use `getFullOrganization` with an explicit `organizationId` query.
  // It is on the lint allowlist precisely because the org id is supplied
  // by the caller (here, derived from the URL slug) instead of relying on
  // session-active-org state. `listMembers` would be banned in this file.
  const fullOrgResult = await authClient.organization.getFullOrganization({
    query: { organizationId },
  });
  const members = (fullOrgResult?.data?.members ?? []) as Array<{
    userId: string;
    role?: string;
  }>;
  const role = members.find((member) => member.userId === user.id)?.role;

  if (role !== "owner" && role !== "admin") {
    toast.error("You don't have access to this page.");
    throw redirect({ to: "/$org", params: { org: params.org } });
  }
}
