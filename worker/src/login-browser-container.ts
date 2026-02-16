/**
 * LoginBrowserContainer — Cloudflare Container that runs a headless
 * Chromium browser with Playwright + stealth measures.
 *
 * Extends the Container class from @cloudflare/containers. The actual
 * browser logic runs inside the Docker container (container/src/server.ts).
 * This class just configures the container lifecycle.
 */

import { Container } from "@cloudflare/containers";

export class LoginBrowserContainer extends Container {
  /** Port the container's HTTP server listens on. */
  defaultPort = 3000;

  /** Ping endpoint for health checks (Container class polls this). */
  override pingEndpoint = "health";

  /** Sleep after 15 min of inactivity. */
  sleepAfter = "15m";

  /** Container needs internet to navigate to login pages. */
  enableInternet = true;

  override onStart(): void {
    console.log("[LoginBrowserContainer] Container started");
  }

  override onStop(): void {
    console.log("[LoginBrowserContainer] Container stopped");
  }

  override onError(error: unknown): Response | void {
    console.error("[LoginBrowserContainer] Container error:", error);
  }
}
