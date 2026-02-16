/**
 * Login Machine Browser Worker — routes HTTP requests to a Container
 * running headless Chromium with Playwright.
 *
 * API surface:
 *   POST /sessions              → Start container, launch browser, navigate
 *   POST /sessions/:id/:action  → Forward action to container
 *   DELETE /sessions/:id        → Close browser session
 *   GET  /health                → Worker health check
 *
 * All requests (except /health) require Bearer token auth.
 */

import { getContainer, type Container } from "@cloudflare/containers";
import { validateAuth } from "./auth.js";

export { LoginBrowserContainer } from "./login-browser-container.js";

export interface Env {
  LOGIN_SESSIONS: DurableObjectNamespace<Container>;
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
          return await forwardToContainer(env, route.sessionId!, `/${route.action!}`, request);

        case "delete_session":
          return await forwardToContainer(env, route.sessionId!, "/close", request);

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

/** Create a new container instance and launch the browser. */
async function handleCreateSession(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await request.json<{ url: string }>();
  if (!body.url) return errorResponse("Missing 'url' in request body", 400);

  // Each session gets its own container instance (unique ID)
  const sessionId = crypto.randomUUID();
  const container = getContainer(env.LOGIN_SESSIONS, sessionId);

  // Forward the launch request to the container
  const launchRequest = new Request("https://container/launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: body.url }),
  });

  const response = await container.fetch(launchRequest);

  if (!response.ok) {
    const data = await response.json<{ error?: string }>();
    return errorResponse(
      data.error || "Failed to launch browser",
      response.status,
    );
  }

  return jsonResponse({
    sessionId,
    liveViewUrl: null, // Containers don't have embeddable live view
  });
}

/** Forward a request to an existing container by session ID. */
async function forwardToContainer(
  env: Env,
  sessionId: string,
  path: string,
  originalRequest: Request,
): Promise<Response> {
  const container = getContainer(env.LOGIN_SESSIONS, sessionId);

  // Build the forwarded request
  const containerRequest = new Request(`https://container${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: originalRequest.body,
  });

  return container.fetch(containerRequest);
}
