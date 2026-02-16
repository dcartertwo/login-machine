/**
 * Browser automation — provider-aware public API.
 *
 * Routes to BrowserBase or Cloudflare Browser Rendering based on the
 * BROWSER_PROVIDER environment variable. Default is "browserbase" for
 * backward compatibility.
 *
 * All consumers (agent.ts, route.ts) import from this file and are
 * unaware of which provider is active.
 */

import * as browserbase from "./providers/browserbase";
import * as cloudflare from "./providers/cloudflare";

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

type Provider = "browserbase" | "cloudflare";

function getProvider(): Provider {
  const provider = process.env.BROWSER_PROVIDER || "browserbase";
  if (provider !== "browserbase" && provider !== "cloudflare") {
    throw new Error(
      `Invalid BROWSER_PROVIDER: "${provider}". Must be "browserbase" or "cloudflare".`,
    );
  }
  return provider;
}

// ---------------------------------------------------------------------------
// Unified BrowserSession type
// ---------------------------------------------------------------------------

/**
 * Unified BrowserSession that works with both providers.
 *
 * For BrowserBase: page, browser, context are real Playwright objects.
 * For Cloudflare: page, browser, context are null (operations go via HTTP).
 */
export type BrowserSession =
  | browserbase.BrowserSession
  | cloudflare.BrowserSession;

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export async function createSession(): Promise<BrowserSession> {
  return getProvider() === "cloudflare"
    ? cloudflare.createSession()
    : browserbase.createSession();
}

export async function getSession(sessionId: string): Promise<BrowserSession> {
  return getProvider() === "cloudflare"
    ? cloudflare.getSession(sessionId)
    : browserbase.getSession(sessionId);
}

export async function closeSession(sessionId: string): Promise<void> {
  return getProvider() === "cloudflare"
    ? cloudflare.closeSession(sessionId)
    : browserbase.closeSession(sessionId);
}

// ---------------------------------------------------------------------------
// Page context extraction
// ---------------------------------------------------------------------------

export async function getPageContext(
  session: BrowserSession,
): Promise<{ html: string; screenshot: string; url: string }> {
  return getProvider() === "cloudflare"
    ? cloudflare.getPageContext(session as cloudflare.BrowserSession)
    : browserbase.getPageContext(session as browserbase.BrowserSession);
}

// ---------------------------------------------------------------------------
// Wait for meaningful page content
// ---------------------------------------------------------------------------

export async function waitForPageContent(
  session: BrowserSession,
): Promise<void> {
  return getProvider() === "cloudflare"
    ? cloudflare.waitForPageContent(session as cloudflare.BrowserSession)
    : browserbase.waitForPageContent(session as browserbase.BrowserSession);
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

export async function navigateTo(
  session: BrowserSession,
  url: string,
): Promise<void> {
  return getProvider() === "cloudflare"
    ? cloudflare.navigateTo(session as cloudflare.BrowserSession, url)
    : browserbase.navigateTo(session as browserbase.BrowserSession, url);
}

// ---------------------------------------------------------------------------
// Form interaction
// ---------------------------------------------------------------------------

export async function fillAndSubmit(
  session: BrowserSession,
  inputs: Array<{ locator: string; value: string }>,
  submitLocator: string,
): Promise<void> {
  return getProvider() === "cloudflare"
    ? cloudflare.fillAndSubmit(session as cloudflare.BrowserSession, inputs, submitLocator)
    : browserbase.fillAndSubmit(session as browserbase.BrowserSession, inputs, submitLocator);
}

export async function clickElement(
  session: BrowserSession,
  locator: string,
): Promise<void> {
  return getProvider() === "cloudflare"
    ? cloudflare.clickElement(session as cloudflare.BrowserSession, locator)
    : browserbase.clickElement(session as browserbase.BrowserSession, locator);
}

// ---------------------------------------------------------------------------
// Locator validation (provider-aware)
// ---------------------------------------------------------------------------

/**
 * Validate whether a locator exists in the live DOM.
 *
 * BrowserBase: uses local Playwright page object.
 * Cloudflare: calls the DO's /validate-locators endpoint.
 */
export async function validateLocator(
  session: BrowserSession,
  locator: string,
): Promise<boolean> {
  if (getProvider() === "cloudflare") {
    const results = await cloudflare.validateLocators(
      session as cloudflare.BrowserSession,
      [locator],
    );
    return results[0]?.exists ?? false;
  }

  // BrowserBase: local Playwright validation
  const bbSession = session as browserbase.BrowserSession;
  const page = bbSession.page;

  try {
    if ((await page.locator(locator).first().count()) > 0) return true;
  } catch {
    // Fall through to iframes
  }

  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      if ((await frame.locator(locator).first().count()) > 0) return true;
    } catch {
      // Next frame
    }
  }
  return false;
}
