#!/bin/sh
# Prove a rendered Openotes launcher can start the application.
#
#   check-launcher.sh <launcher> <target> [--pins <lib-dir>] [--version <v>]
#
# <target> is the exact text between `exec` and `"$@"` on the hand-over
# line: /usr/lib/openotes/openotes for a package, "$HERE/AppRun.wrapped"
# for the AppImage.
#
# 2.2.1 shipped launchers that parsed but did not launch: the AppImage,
# .deb and .rpm still carried `exec @TARGET@`, and the Arch package had a
# comment folded into an `export` line, which `sh -n` accepts and a real
# run refuses. So this runs the launcher. First a copy whose hand-over is
# swapped for /usr/bin/env, which executes every line before the exec and
# prints the environment it would have handed the application; then, with
# --version, the real launcher, which must answer with that version.
set -eu

launcher=${1:?launcher}
target=${2:?target}
shift 2
pins=
expected=
while [ $# -gt 0 ]; do
  case $1 in
    --pins) pins=$2; shift 2 ;;
    --version) expected=$2; shift 2 ;;
    *) echo "check-launcher: unknown option $1" >&2; exit 2 ;;
  esac
done

fail() { echo "check-launcher: $launcher: $*" >&2; exit 1; }

test -f "$launcher" || fail "does not exist"
sh -n "$launcher" || fail "does not parse"
if grep -n '@PRELUDE@\|@TARGET@' "$launcher" | grep -v '^[0-9]*:#'; then
  fail "still carries a placeholder"
fi
handover="exec $target \"\$@\""
grep -qxF -- "$handover" "$launcher" || fail "does not hand over with: $handover"

probe=$(mktemp)
trap 'rm -f "$probe"' EXIT
awk -v line="$handover" '$0 == line { print "exec /usr/bin/env"; next } { print }' \
  "$launcher" > "$probe"
grep -qx 'exec /usr/bin/env' "$probe" || fail "could not swap the hand-over for a probe"

# The environment a desktop launcher offers: next to no PATH, no login
# shell already run, and one that refuses to run now.
handed=$(env -i PATH=/usr/bin:/bin HOME="${HOME:-/}" SHELL=/bin/false sh "$probe" --version) \
  || fail "failed before handing over (exit $?)"
echo "$handed" | grep -q '^PATH=' || fail "handed over without a PATH"
if [ -n "$pins" ]; then
  echo "$handed" | grep -qx "OPENOTES_UI_ROOT=$pins/ui" \
    || fail "did not pin OPENOTES_UI_ROOT to $pins/ui"
  echo "$handed" | grep -qx "OPENOTES_NATIVE_DIR=$pins/native" \
    || fail "did not pin OPENOTES_NATIVE_DIR to $pins/native"
fi

if [ -n "$expected" ]; then
  answer=$("$launcher" --version 2>&1) || fail "--version failed: $answer"
  [ "$answer" = "Openotes $expected" ] \
    || fail "--version answered \"$answer\", expected \"Openotes $expected\""
fi
echo "check-launcher: $launcher hands over to $target"
