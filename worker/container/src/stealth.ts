/**
 * Stealth measures — injected via page.addInitScript() before every navigation.
 *
 * Overrides browser automation fingerprints that bot detectors look for.
 * This won't fool sophisticated server-side detection (IP reputation, TLS
 * fingerprinting), but handles the common client-side JS checks.
 */

import type { BrowserContext } from "playwright";

/** Realistic Chrome user agent string. */
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Script injected into every frame before any page JavaScript runs.
 * Patches the most common automation detection vectors.
 */
const STEALTH_SCRIPT = `
  // 1. navigator.webdriver — the #1 bot detection signal
  //    Must override on Navigator.prototype (not navigator instance) because
  //    Chromium defines it there. Non-configurable prevents CDP from resetting.
  delete Navigator.prototype.webdriver;
  Object.defineProperty(Navigator.prototype, 'webdriver', {
    get: () => false,
    configurable: false,
  });

  // 2. navigator.plugins — real browsers always have plugins
  //    Must pass: instanceof PluginArray, toString tag, constructor check
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const fakePlugins = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 1 },
      ];
      const arr = Object.create(PluginArray.prototype);
      for (let i = 0; i < fakePlugins.length; i++) {
        // Each plugin must also pass instanceof Plugin
        arr[i] = Object.create(Plugin.prototype, {
          name: { value: fakePlugins[i].name, enumerable: true },
          filename: { value: fakePlugins[i].filename, enumerable: true },
          description: { value: fakePlugins[i].description, enumerable: true },
          length: { value: fakePlugins[i].length, enumerable: true },
        });
      }
      Object.defineProperty(arr, 'length', { get: () => fakePlugins.length });
      Object.defineProperty(arr, Symbol.toStringTag, { value: 'PluginArray' });
      arr.item = (i) => arr[i] || null;
      arr.namedItem = (name) => fakePlugins.find((p) => p.name === name) || null;
      arr.refresh = () => {};
      return arr;
    },
    configurable: true,
  });

  // 3. navigator.languages — must be consistent with Accept-Language header
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
    configurable: true,
  });

  // 4. chrome.runtime — real Chrome has this, Playwright doesn't
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      connect: () => {},
      sendMessage: () => {},
      onMessage: { addListener: () => {} },
    };
  }

  // 5. Permissions API — make "notifications" return "default" not "denied"
  const originalQuery = window.navigator.permissions?.query;
  if (originalQuery) {
    window.navigator.permissions.query = (parameters) => {
      if (parameters.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission });
      }
      return originalQuery(parameters);
    };
  }

  // 6. WebGL vendor/renderer — don't leak "Google SwiftShader"
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function (param) {
    if (param === 37445) return 'Intel Inc.';           // UNMASKED_VENDOR_WEBGL
    if (param === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
    return getParameter.call(this, param);
  };
`;

/**
 * Apply stealth measures to a browser context.
 * Must be called BEFORE any pages are created or navigated.
 */
export async function applyStealthToContext(
  context: BrowserContext,
): Promise<void> {
  await context.addInitScript(STEALTH_SCRIPT);
}
