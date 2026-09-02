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

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  pinnedResources,
  renderLauncherTemplate,
} from "../scripts/launcher.ts";

const TEMPLATE_PATH = new URL(
  "../../../packaging/linux/openotes-launcher.sh",
  import.meta.url,
);

/**
 * The launcher every Linux package starts through. 2.2.1 shipped it with
 * its placeholders still in place, on every format, and nothing started;
 * these run the real template through the real renderer and then run the
 * result.
 */

Deno.test("the shipped template renders with no placeholder left", async () => {
  const template = await Deno.readTextFile(TEMPLATE_PATH);
  const rendered = renderLauncherTemplate(template, {
    target: "/usr/lib/openotes/openotes",
    prelude: pinnedResources("/usr/lib/openotes"),
  });
  assert(!rendered.includes("@PRELUDE@"));
  assert(!rendered.includes("@TARGET@"));
  assert(rendered.includes('exec /usr/lib/openotes/openotes "$@"'));
  assert(
    rendered.includes(
      'OPENOTES_UI_ROOT="${OPENOTES_UI_ROOT:-/usr/lib/openotes/ui}"',
    ),
  );
});

Deno.test("a mention of a placeholder in prose is not what gets filled in", () => {
  // The 2.2.1 defect, reproduced: a comment that names the placeholder
  // came first and a plain replace filled the comment in.
  const template = [
    "#!/bin/sh",
    "# @PRELUDE@ pins things and @TARGET@ is the program",
    "@PRELUDE@",
    'exec @TARGET@ "$@"',
    "",
  ].join("\n");
  const rendered = renderLauncherTemplate(template, {
    target: "/opt/app/bin",
    prelude: "X=1",
  });
  assertEquals(rendered.split("\n")[2], "X=1");
  assertEquals(rendered.split("\n")[3], 'exec /opt/app/bin "$@"');
});

Deno.test("a template without the placeholder lines is refused", () => {
  assertThrows(
    () => renderLauncherTemplate("#!/bin/sh\nexec foo\n", { target: "x" }),
    Error,
    "lost",
  );
});

Deno.test({
  name: "the rendered launcher parses, runs, and hands over with the pins set",
  ignore: Deno.build.os === "windows",
  async fn() {
    const template = await Deno.readTextFile(TEMPLATE_PATH);
    const script = await Deno.makeTempFile({ suffix: ".sh" });
    await Deno.writeTextFile(
      script,
      renderLauncherTemplate(template, {
        target: "/usr/bin/env",
        prelude: pinnedResources("/usr/lib/openotes"),
      }),
    );
    try {
      const parse = await new Deno.Command("sh", { args: ["-n", script] })
        .output();
      assertEquals(parse.code, 0, new TextDecoder().decode(parse.stderr));

      const run = await new Deno.Command("sh", {
        args: [script],
        env: {
          PATH: "/usr/bin:/bin",
          HOME: "/nonexistent",
          SHELL: "/bin/false",
        },
        clearEnv: true,
      }).output();
      assertEquals(run.code, 0, new TextDecoder().decode(run.stderr));
      const output = new TextDecoder().decode(run.stdout);
      assert(output.includes("OPENOTES_UI_ROOT=/usr/lib/openotes/ui"));
      assert(output.includes("OPENOTES_NATIVE_DIR=/usr/lib/openotes/native"));
      assert(/^PATH=\/usr\/bin:\/bin/m.test(output));
    } finally {
      await Deno.remove(script).catch(() => {});
    }
  },
});
