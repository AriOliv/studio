/**
 * Errors thrown while resolving the outbound credentials for a downstream
 * MCP request.
 *
 * The MCP proxy catches these and turns them into structured tool errors so
 * Claude Desktop (or any other client) can surface an actionable message —
 * typically a URL the user has to open to finish authorising.
 */

/**
 * Thrown by the token resolver when the connection is configured with
 * `auth_mode = "per_user"` and the caller has not yet authorised the
 * downstream provider with their own account.
 *
 * `authorizeUrl` is an in-Studio URL — opening it kicks off the OAuth
 * proxy authorize flow on behalf of the current session.
 */
export class PerUserAuthorizationRequiredError extends Error {
  public readonly connectionId: string;
  public readonly authorizeUrl: string;
  public readonly connectionTitle: string;

  constructor(args: {
    connectionId: string;
    connectionTitle: string;
    authorizeUrl: string;
  }) {
    super(
      `This connection requires per-user authorization. ` +
        `Connect your "${args.connectionTitle}" account: ${args.authorizeUrl}`,
    );
    this.name = "PerUserAuthorizationRequiredError";
    this.connectionId = args.connectionId;
    this.connectionTitle = args.connectionTitle;
    this.authorizeUrl = args.authorizeUrl;
  }
}

export function isPerUserAuthorizationRequiredError(
  error: unknown,
): error is PerUserAuthorizationRequiredError {
  return error instanceof PerUserAuthorizationRequiredError;
}

/**
 * A downstream 401/403 is a credential problem for THIS caller (expired or
 * revoked token, member not yet connected), not evidence that the server is
 * down. The circuit breaker exists to bound latency on an unreachable server;
 * counting auth rejections opens it after three members with stale tokens and
 * then 503s everyone, including members whose tokens are fine.
 *
 * Covers our own `PerUserAuthorizationRequiredError`, the MCP SDK's
 * `UnauthorizedError` / `StreamableHTTPError(401|403)` / `SseError(401)`, and
 * any error carrying an HTTP status or `401` in its message (the SDK formats
 * transport failures as "Error POSTing to endpoint (HTTP 401): ...").
 */
export function isDownstreamAuthError(error: unknown): boolean {
  if (isPerUserAuthorizationRequiredError(error)) return true;
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  const status = (error as { status?: unknown }).status;
  if (code === 401 || code === 403 || status === 401 || status === 403) {
    return true;
  }
  const message = error.message.toLowerCase();
  return (
    error.name === "UnauthorizedError" ||
    message.includes("http 401") ||
    message.includes("http 403") ||
    message.includes("unauthorized") ||
    message.includes("invalid_token")
  );
}

/**
 * Render a `PerUserAuthorizationRequiredError` as an HTTP 401 response that
 * non-browser MCP clients (Claude Desktop, Cursor, etc.) can surface to the
 * end user. The body is intentionally simple and the authorize URL is also
 * mirrored in custom headers so dumb clients can grab it without parsing
 * JSON.
 */
export function renderPerUserAuthorizationRequired(
  error: PerUserAuthorizationRequiredError,
): Response {
  const body = {
    error: "per_user_authorization_required",
    message: error.message,
    connection_id: error.connectionId,
    connection_title: error.connectionTitle,
    authorize_url: error.authorizeUrl,
  };

  return new Response(JSON.stringify(body), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer realm="${error.connectionId}", error="per_user_authorization_required", authorize_url="${error.authorizeUrl}"`,
      "X-Authorize-Url": error.authorizeUrl,
    },
  });
}
