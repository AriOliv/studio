import { EmptyState } from "@/web/components/empty-state.tsx";
import { ErrorBoundary } from "@/web/components/error-boundary.tsx";
import {
  useMCPClient,
  useMCPToolCall,
  useProjectContext,
  type ConnectionEntity,
} from "@decocms/mesh-sdk";
import { Button } from "@deco/ui/components/button.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import { Key01, File06, Loading01 } from "@untitledui/icons";
import { Suspense } from "react";
import { useWatch, type useForm } from "react-hook-form";
import { McpConfigurationForm } from "./mcp-configuration-form";
import type { ConnectionFormData } from "./schema";

/**
 * Switch that lets an admin flip a connection between "shared" (one
 * org-wide downstream token) and "per_user" (each member authorises with
 * their own account). Always shown at the top of the settings tab so the
 * policy stays visible regardless of auth state.
 */
function AuthModeToggle({
  form,
}: {
  form: ReturnType<typeof useForm<ConnectionFormData>>;
}) {
  const value = useWatch({ control: form.control, name: "auth_mode" });
  return (
    <div className="flex items-start justify-between rounded-lg border p-3 mb-4">
      <div className="space-y-0.5 pr-4">
        <div className="text-sm font-medium">Per-user authentication</div>
        <p className="text-xs text-muted-foreground">
          When enabled, each member of your org authorises this connection with
          their own account. Audit logs at the provider show the real person
          acting. Disable to share a single org-wide token.
        </p>
      </div>
      <Switch
        checked={value === "per_user"}
        onCheckedChange={(checked) =>
          form.setValue("auth_mode", checked ? "per_user" : "shared", {
            shouldDirty: true,
          })
        }
      />
    </div>
  );
}

interface SettingsTabProps {
  connection: ConnectionEntity;
  form: ReturnType<typeof useForm<ConnectionFormData>>;
  hasMcpBinding: boolean;
  isMCPAuthenticated: boolean;
  supportsOAuth: boolean;
  isServerError?: boolean;
  onAuthenticate: () => void | Promise<void>;
  onViewReadme?: () => void;
}

interface McpConfigurationResult {
  stateSchema: Record<string, unknown>;
  scopes?: string[];
}

function useMcpConfiguration(connectionId: string) {
  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { data: configResult } = useMCPToolCall<McpConfigurationResult>({
    client,
    toolName: "MCP_CONFIGURATION",
    toolArguments: {},
    select: (result) =>
      ((result as { structuredContent?: unknown }).structuredContent ??
        result) as McpConfigurationResult,
  });

  const stateSchema = configResult.stateSchema ?? {
    type: "object",
    properties: {},
  };

  const scopes = configResult.scopes ?? [];

  return { stateSchema, scopes };
}

interface OAuthAuthenticationStateProps {
  onAuthenticate: () => void | Promise<void>;
  buttonText?: string;
  isPerUser?: boolean;
  connectionTitle?: string;
}

export function OAuthAuthenticationState({
  onAuthenticate,
  buttonText,
  isPerUser = false,
  connectionTitle,
}: OAuthAuthenticationStateProps) {
  const headline = isPerUser
    ? "Connect your account"
    : "Authentication Required";
  const description = isPerUser
    ? `This connection runs each tool call as the member who triggered it. ` +
      `Authorise with your own ${connectionTitle ?? "provider"} account to start ` +
      `using these tools — your activity will show up in the provider's audit log under your name.`
    : "This connection requires OAuth authentication to access resources.";
  const cta =
    buttonText ??
    (isPerUser
      ? `Connect ${connectionTitle ?? "your account"}`
      : "Authenticate");

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 max-w-md text-center">
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{headline}</h3>
          <p className="text-xs text-muted-foreground max-w-md text-center">
            {description}
          </p>
        </div>
        <Button onClick={onAuthenticate} size="default">
          {cta}
        </Button>
      </div>
    </div>
  );
}

interface ManualAuthRequiredStateProps {
  hasReadme: boolean;
  onViewReadme?: () => void;
}

export function ManualAuthRequiredState({
  hasReadme,
  onViewReadme,
}: ManualAuthRequiredStateProps) {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 max-w-md text-center">
        <Key01 size={36} className="text-muted-foreground" />
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">
            Manual Authentication Required
          </h3>
          <p className="text-xs text-muted-foreground max-w-md text-center">
            This server requires an API key or token that must be configured
            manually. Check the server's documentation for instructions on
            obtaining credentials.
          </p>
        </div>
        {hasReadme && onViewReadme && (
          <Button onClick={onViewReadme} variant="outline" size="lg">
            <File06 size={18} className="mr-2" />
            View README
          </Button>
        )}
      </div>
    </div>
  );
}

function ServerErrorState() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 max-w-md text-center">
        <img
          src="/empty-state-error.svg"
          alt=""
          width={160}
          height={160}
          aria-hidden="true"
        />
        <div className="flex flex-col gap-2">
          <h3 className="text-lg font-semibold">Server Error</h3>
          <p className="text-sm text-muted-foreground max-w-md text-center">
            The MCP server is currently experiencing issues. Please try again
            later or check the server's status.
          </p>
        </div>
      </div>
    </div>
  );
}

function McpConfigurationContent({
  connection,
  form,
}: {
  connection: ConnectionEntity;
  form: ReturnType<typeof useForm<ConnectionFormData>>;
}) {
  const { stateSchema } = useMcpConfiguration(connection.id);

  // useWatch is more reliable for triggering re-renders than form.watch()
  const formState = useWatch({
    control: form.control,
    name: "configuration_state",
  });

  const handleFormStateChange = (state: Record<string, unknown>) => {
    form.setValue("configuration_state", state, { shouldDirty: true });
  };

  const hasProperties =
    stateSchema &&
    stateSchema.properties &&
    typeof stateSchema.properties === "object" &&
    Object.keys(stateSchema.properties).length > 0;

  if (!hasProperties) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState
          image={
            <img
              src="/empty-state-success-muted.svg"
              alt=""
              width={220}
              height={200}
              aria-hidden="true"
            />
          }
          title="This server is all set!"
          description="No additional configuration is needed. Everything is ready to go."
        />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <McpConfigurationForm
        formKey={connection.id}
        stateSchema={stateSchema}
        formState={formState ?? {}}
        onFormStateChange={handleFormStateChange}
      />
    </div>
  );
}

function SettingsTabContent(props: SettingsTabProps) {
  const {
    connection,
    form,
    hasMcpBinding,
    isMCPAuthenticated,
    supportsOAuth,
    isServerError,
    onAuthenticate,
    onViewReadme,
  } = props;

  // Check if connection has README
  const repository = connection?.metadata?.repository as
    | { url?: string }
    | undefined;
  const hasReadme = !!repository?.url;

  // Not authenticated states
  if (!isMCPAuthenticated) {
    if (isServerError) {
      return <ServerErrorState />;
    }
    if (supportsOAuth) {
      return (
        <OAuthAuthenticationState
          onAuthenticate={onAuthenticate}
          isPerUser={connection.auth_mode === "per_user"}
          connectionTitle={connection.title}
        />
      );
    }
    return (
      <ManualAuthRequiredState
        hasReadme={hasReadme}
        onViewReadme={onViewReadme}
      />
    );
  }

  // Authenticated but no MCP binding - show success state
  if (!hasMcpBinding) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <EmptyState
          image={
            <img
              src="/empty-state-success-muted.svg"
              alt=""
              width={220}
              height={200}
              aria-hidden="true"
            />
          }
          title="This server is all set!"
          description="No additional configuration is needed. Everything is ready to go."
        />
      </div>
    );
  }

  // Has MCP binding - show configuration form
  return (
    <ErrorBoundary>
      <Suspense
        fallback={
          <div className="flex-1 flex items-center justify-center">
            <Loading01
              size={32}
              className="animate-spin text-muted-foreground"
            />
          </div>
        }
      >
        <McpConfigurationContent connection={connection} form={form} />
      </Suspense>
    </ErrorBoundary>
  );
}

export function SettingsTab(props: SettingsTabProps) {
  return (
    <div className="flex-1 flex flex-col h-full">
      <div className="px-4 pt-4">
        <AuthModeToggle form={props.form} />
      </div>
      <SettingsTabContent {...props} />
    </div>
  );
}
