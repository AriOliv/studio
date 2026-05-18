import { AccountPopover } from "@/web/components/account-popover";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@deco/ui/components/sidebar.tsx";
import { Settings02 } from "@untitledui/icons";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";
import { useCurrentMemberRole } from "@/web/hooks/use-current-member-role";

export function SidebarInboxFooterMobile() {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const { setOpenMobile } = useSidebar();
  const { canManageOrg } = useCurrentMemberRole();

  return (
    <SidebarFooter>
      <SidebarMenu>
        {canManageOrg && (
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Settings"
              onClick={() => {
                navigate({
                  to: "/$org/settings",
                  params: { org: org.slug },
                });
                setOpenMobile(false);
              }}
            >
              <Settings02 />
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
        <SidebarMenuItem>
          <AccountPopover />
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}
