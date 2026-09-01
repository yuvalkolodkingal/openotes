/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

import "./polyfills";
import "./app.css";
import { AppEventManager, AppEvents } from "./common/app-events";
import { register } from "./service-worker-registration";
import { getServiceWorkerVersion } from "./utils/version";
import { register as registerStreamSaver } from "./utils/stream-saver/mitm";
import { themeToCSS } from "@notesnook/theme";
import { storedTheme } from "./common/default-theme";
import Config from "./utils/config";
import { hydrateDesktopConfig } from "./utils/config-persistence";
import { setI18nGlobal, Messages } from "@notesnook/intl";
import { i18n } from "@lingui/core";

// On desktop, persisted settings live on the runtime because this page's
// origin (and its localStorage) changes every launch. They must be seeded
// into localStorage before anything reads Config — the theme below, and the
// stores loaded through import("./root"), which read Config at module
// evaluation. On the web this resolves immediately.
/**
 * Put a start-up failure on the screen.
 *
 * Everything between hydration and startApp used to run with no rejection
 * handler at all: the promise was dropped, the engine swallowed the error,
 * and the splash stayed up forever with nothing logged anywhere. That is
 * precisely what 2.1.0 looked like when the interface server refused the
 * entry bundle — a permanent "Starting up the engines" and no way to tell
 * why without instrumenting the page by hand. Whatever the next start-up
 * failure is, it should say so.
 */
function reportBootFailure(error: unknown) {
  // First, so this reaches somewhere even if the DOM work below throws too.
  console.error("Openotes could not start", error);

  const splash = document.getElementById("splash");
  const label = splash?.querySelector("span");
  if (!splash || !label) return;

  label.textContent = "Openotes could not start.";
  const detail = document.createElement("pre");
  detail.textContent = error instanceof Error
    ? `${error.message}\n\n${error.stack ?? ""}`.trim()
    : String(error);
  detail.style.cssText = "max-width:70ch;margin:1rem 1rem 0;padding:0.75rem;" +
    "white-space:pre-wrap;text-align:left;font-size:0.72rem;line-height:1.5;" +
    "opacity:0.85;overflow:auto;max-height:45vh;border-radius:6px;" +
    "background:color-mix(in srgb, currentColor 8%, transparent)";
  splash.appendChild(detail);
}

hydrateDesktopConfig()
  .catch(() => {
    /* already logged; the app runs on defaults for this session */
  })
  .then(async () => {
    const colorScheme = JSON.parse(
      window.localStorage.getItem("colorScheme") || '"light"'
    );
    const root = document.querySelector("html");
    if (root) root.setAttribute("data-theme", colorScheme);

    // storedTheme, not a raw Config.get: a stored copy of a shipped theme is
    // ignored once the shipped one has moved on. See common/default-theme.ts.
    const theme = storedTheme(colorScheme === "dark" ? "dark" : "light");
    const stylesheet = document.getElementById("theme-colors");
    if (theme) {
      const css = themeToCSS(theme);
      if (stylesheet) stylesheet.innerHTML = css;
    } else stylesheet?.remove();

    // The runtime stamps a <style id="boot-theme"> into the document so the
    // first frame is painted in the right colour instead of flashing white.
    // It is last in <head>, so it outranks the real theme, and it names one
    // scheme's background as a literal — which would then survive every
    // theme change for the life of the page. It has done its job by now.
    document.getElementById("boot-theme")?.remove();

    const locale = import.meta.env.DEV
      ? import("@notesnook/intl/locales/$pseudo-LOCALE.json")
      : import("@notesnook/intl/locales/$en.json");
    setI18nGlobal(i18n);

    // Awaited rather than chained, so a failure anywhere below reaches the
    // catch at the end instead of becoming an unhandled rejection.
    const { default: messages } = await locale;
    i18n.load({ en: messages.messages as unknown as Messages });
    i18n.activate("en");

    performance.mark("import:root");
    const { startApp } = await import("./root");
    performance.mark("start:app");
    startApp();
  })
  .catch(reportBootFailure);

if (!IS_DESKTOP_APP) {
  //   logger.info("Initializing service worker...");

  // If you want your app to work offline and load faster, you can change
  // unregister() to register() below. Note this comes with some pitfalls.
  // Learn more about service workers: https://bit.ly/CRA-PWA
  register({
    onUpdate: async (registration: ServiceWorkerRegistration) => {
      if (!registration.waiting) return;
      const { formatted } = await getServiceWorkerVersion(registration.waiting);
      AppEventManager.publish(AppEvents.updateDownloadCompleted, {
        version: formatted
      });
    },
    onSuccess() {
      registerStreamSaver();
    }
  });

  // window.addEventListener("beforeinstallprompt", () => showInstallNotice());
}
