/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited
Copyright (C) 2026 Openotes contributors

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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { listenForRedirect } from "../src/oauth/loopback.ts";

/** The listener binds 127.0.0.1 whatever host it reports; use that. */
function callbackUrl(redirectUri: string, query: string): string {
  const url = new URL(redirectUri);
  return `http://127.0.0.1:${url.port}${url.pathname}?${query}`;
}

Deno.test("a matching redirect yields the authorization code", async () => {
  const listener = listenForRedirect({
    host: "127.0.0.1",
    expectedState: "the-state",
  });
  const response = await fetch(
    callbackUrl(listener.redirectUri, "code=abc123&state=the-state"),
  );
  await response.body?.cancel();
  assertEquals(response.status, 200);
  assertEquals(await listener.result, { code: "abc123", state: "the-state" });
  await listener.close();
});

Deno.test("a redirect with the wrong state is refused", async () => {
  const listener = listenForRedirect({
    host: "127.0.0.1",
    expectedState: "the-state",
  });
  // Anything on the machine can post to a loopback port. Only the flow that
  // started this one knows its state, so a mismatch is someone else's
  // redirect — or a forged one — and the code must not be touched.
  const response = await fetch(
    callbackUrl(listener.redirectUri, "code=stolen&state=guessed"),
  );
  await response.body?.cancel();
  assertEquals(response.status, 400);
  await assertRejects(() => listener.result, Error, "did not match");
  await listener.close();
});

Deno.test("the provider's refusal is reported, not swallowed", async () => {
  const listener = listenForRedirect({
    host: "127.0.0.1",
    expectedState: "s",
  });
  const response = await fetch(
    callbackUrl(
      listener.redirectUri,
      "error=access_denied&error_description=User%20said%20no",
    ),
  );
  await response.body?.cancel();
  assertEquals(response.status, 400);
  await assertRejects(() => listener.result, Error, "access_denied");
  await listener.close();
});

Deno.test("the landing page never echoes the query string", async () => {
  const listener = listenForRedirect({
    host: "127.0.0.1",
    expectedState: "s",
  });
  const response = await fetch(
    callbackUrl(
      listener.redirectUri,
      "error=%3Cscript%3Ealert(1)%3C%2Fscript%3E&state=s",
    ),
  );
  const body = await response.text();
  assertEquals(body.includes("<script>"), false);
  assertEquals(body.includes("alert(1)"), false);
  await listener.result.catch(() => {});
  await listener.close();
});

Deno.test("the redirect uri uses the host the provider expects", () => {
  const google = listenForRedirect({
    host: "127.0.0.1",
    expectedState: "s",
  });
  assert(google.redirectUri.startsWith("http://127.0.0.1:"));
  assert(google.redirectUri.endsWith("/oauth/callback"));

  const microsoft = listenForRedirect({
    host: "localhost",
    expectedState: "s",
  });
  assert(microsoft.redirectUri.startsWith("http://localhost:"));

  return Promise.all([google.close(), microsoft.close()])
    .then(() =>
      Promise.all([
        google.result.catch(() => {}),
        microsoft.result.catch(() => {}),
      ])
    )
    .then(() => {});
});

Deno.test("giving up stops listening", async () => {
  const listener = listenForRedirect({
    host: "127.0.0.1",
    expectedState: "s",
    timeoutMs: 50,
  });
  const port = new URL(listener.redirectUri).port;
  await assertRejects(() => listener.result, Error, "Timed out");

  // A port left open after a failed sign-in is a port anything on the
  // machine can post a code to. Whether the kernel answers a connect with
  // a refusal or a reset is not ours to choose; that it does not serve is.
  let served = false;
  try {
    const response = await fetch(
      `http://127.0.0.1:${port}/oauth/callback?code=x&state=s`,
    );
    await response.body?.cancel();
    served = true;
  } catch {
    served = false;
  }
  assertEquals(served, false, "the listener is still answering");
});
