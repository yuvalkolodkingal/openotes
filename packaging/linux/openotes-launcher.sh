#!/bin/sh
# This file is part of the Notesnook project (https://notesnook.com/)
#
# Copyright (C) 2026 Openotes contributors
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>.

# The launcher every packaged Linux build starts through.
#
# WHY A WRAPPER
#
# The AI assistant launches an agent -- claude-agent-acp, gemini, opencode --
# and the runtime will only start a program it found on PATH when the process
# began; the permission set binds each allowed name to that binary, and
# extending PATH later does not help (apps/desktop/src/acp/service.ts).
#
# An application started from a launcher, a dock or a .desktop file gets the
# session's PATH, which is not the one a login shell builds: nothing installed
# with `npm install -g` under nvm, volta, fnm, Homebrew or ~/.local/bin is on
# it. So every packaged build reported those agents as "found, but not
# launchable", and the assistant did not work for anyone who had not started
# Openotes from a terminal. This adds those directories -- and the PATH the
# user's own login shell reports, when it answers quickly -- before the
# runtime starts, which is the only time it can be done.
#
# It runs outside the runtime's sandbox, as the user, and starts nothing but
# the user's own shell to ask it a question. Set OPENOTES_NO_SHELL_PATH=1 to
# skip that question and keep only the well-known directories.
#
# Placeholders are filled in by apps/desktop/scripts/build.ts (or by a
# package recipe): @PRELUDE@ pins OPENOTES_UI_ROOT/OPENOTES_NATIVE_DIR where
# the package needs it, and @TARGET@ is the program to exec.

@PRELUDE@

openotes_extend_path() {
  home="${HOME:-}"
  extra=""
  for dir in \
    "$home/.local/bin" \
    "$home/.npm-global/bin" \
    "$home/.bun/bin" \
    "$home/.deno/bin" \
    "$home/.volta/bin" \
    "$home/.cargo/bin" \
    /usr/local/bin \
    /opt/homebrew/bin \
    /snap/bin; do
    [ -d "$dir" ] && extra="$extra:$dir"
  done
  # Version managers keep one bin directory per installed Node.
  for dir in \
    "$home"/.nvm/versions/node/*/bin \
    "$home"/.local/share/fnm/node-versions/*/installation/bin \
    "$home"/.fnm/node-versions/*/installation/bin; do
    [ -d "$dir" ] && extra="$extra:$dir"
  done

  # The PATH the user's login shell builds is the authoritative answer, but
  # a shell that hangs on start must not hang the application: give it a few
  # seconds, and do without it otherwise.
  if [ -z "${OPENOTES_NO_SHELL_PATH:-}" ] && [ -n "${SHELL:-}" ] && [ -x "$SHELL" ]; then
    if command -v timeout >/dev/null 2>&1; then
      shell_path=$(timeout 3 "$SHELL" -lc 'printf %s "$PATH"' 2>/dev/null </dev/null)
    else
      shell_path=$("$SHELL" -lc 'printf %s "$PATH"' 2>/dev/null </dev/null)
    fi
    case "$shell_path" in
      */*) extra="$extra:$shell_path" ;;
    esac
  fi

  # Append rather than prepend: a directory the session already put first
  # keeps winning, so this can only make more programs visible, never change
  # which one an existing name resolves to.
  PATH="$PATH$extra"
  export PATH
}

openotes_extend_path

exec @TARGET@ "$@"
