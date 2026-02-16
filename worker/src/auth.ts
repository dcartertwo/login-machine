/**
 * Shared-secret authentication middleware.
 *
 * Validates a Bearer token against the AUTH_SECRET environment variable.
 * Returns null if valid, or a 401 Response if invalid.
 */

/** Validate the Authorization header. Returns null on success, 401 Response on failure. */
export function validateAuth(
  request: Request,
  authSecret: string,
): Response | null {
  if (!authSecret) {
    return new Response(
      JSON.stringify({ error: "AUTH_SECRET not configured on worker" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return new Response(
      JSON.stringify({ error: "Missing Authorization header" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;

  if (token !== authSecret) {
    return new Response(
      JSON.stringify({ error: "Invalid authorization token" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  return null;
}
