/**
 * Login Machine Browser Worker — routes HTTP requests to LoginBrowserDO.
 *
 * API surface:
 *   POST /sessions              → Create DO, launch browser, navigate
 *   POST /sessions/:id/:action  → Route action to existing DO
 *   DELETE /sessions/:id        → Close browser session
 *   GET  /health                → Worker health check
 *
 * All requests (except /health) require Bearer token auth.
 */

import { validateAuth } from "./auth";

export { LoginBrowserDO } from "./login-browser-do";

export interface Env {
  MYBROWSER: Fetcher;
  LOGIN_SESSIONS: DurableObjectNamespace;
  AUTH_SECRET: string;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 500): Response {
  return jsonResponse({ error: message }, status);
}

// ---------------------------------------------------------------------------
// Route parsing
// ---------------------------------------------------------------------------

interface ParsedRoute {
  type: "create_session" | "session_action" | "delete_session" | "health" | "unknown";
  sessionId?: string;
  action?: string;
}

function parseRoute(method: string, pathname: string): ParsedRoute {
  if (pathname === "/health") return { type: "health" };

  // POST /sessions → create
  if (method === "POST" && pathname === "/sessions") {
    return { type: "create_session" };
  }

  // Match /sessions/:id or /sessions/:id/:action
  const match = pathname.match(/^\/sessions\/([^/]+)(?:\/(.+))?$/);
  if (!match) return { type: "unknown" };

  const sessionId = match[1];
  const action = match[2];

  if (method === "DELETE" || action === "close") {
    return { type: "delete_session", sessionId };
  }

  if (method === "POST" && action) {
    return { type: "session_action", sessionId, action };
  }

  return { type: "unknown" };
}

// ---------------------------------------------------------------------------
// Worker fetch handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = parseRoute(request.method, url.pathname);

    // Health check — no auth required
    if (route.type === "health") {
      return jsonResponse({ status: "ok", timestamp: new Date().toISOString() });
    }

    // All other routes require auth
    const authError = validateAuth(request, env.AUTH_SECRET);
    if (authError) return authError;

    try {
      switch (route.type) {
        case "create_session":
          return await handleCreateSession(request, env);

        case "session_action":
          return await forwardToDO(env, route.sessionId!, `/${route.action!}`, request);

        case "delete_session":
          return await forwardToDO(env, route.sessionId!, "/close", request);

        default:
          return errorResponse(`Unknown route: ${request.method} ${url.pathname}`, 404);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Worker] Error:`, message);
      return errorResponse(message);
    }
  },
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/** Create a new DO instance and launch the browser. */
async function handleCreateSession(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await request.json<{ url: string }>();
  if (!body.url) return errorResponse("Missing 'url' in request body", 400);

  // Create a unique DO ID for this session
  const doId = env.LOGIN_SESSIONS.newUniqueId();
  const stub = env.LOGIN_SESSIONS.get(doId);

  // Forward the launch request to the DO
  const doRequest = new Request("https://do/launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: body.url }),
  });

  const response = await stub.fetch(doRequest);

  if (!response.ok) {
    const data = await response.json<{ error?: string }>();
    return errorResponse(
      data.error || "Failed to launch browser",
      response.status,
    );
  }

  // Return the DO ID as the session ID
  return jsonResponse({
    sessionId: doId.toString(),
    liveViewUrl: null, // CF doesn't have embeddable live view
  });
}

/** Forward a request to an existing DO by session ID. */
async function forwardToDO(
  env: Env,
  sessionId: string,
  path: string,
  originalRequest: Request,
): Promise<Response> {
  let doId: DurableObjectId;
  try {
    doId = env.LOGIN_SESSIONS.idFromString(sessionId);
  } catch {
    return errorResponse(`Invalid session ID: ${sessionId}`, 400);
  }

  const stub = env.LOGIN_SESSIONS.get(doId);

  // Build the forwarded request
  const doRequest = new Request(`https://do${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: originalRequest.body,
  });

  return stub.fetch(doRequest);
}
