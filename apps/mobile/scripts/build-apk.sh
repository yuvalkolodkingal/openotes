#!/usr/bin/env bash
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

# Builds the Android APK: Openotes-<version>-android.apk in apps/mobile/dist.
#
#   scripts/build-apk.sh                     version from package.json
#   OPENOTES_VERSION=2.2.1 scripts/build-apk.sh
#
# Needs Node 22, a JDK (17 or newer) and the Android SDK (ANDROID_HOME) with
# a build-tools directory; `npm ci` must have run. The native project is
# generated fresh by `expo prebuild` every time -- android/ is not checked in
# -- so the only inputs are app.json, app.config.js and the source.
#
# SIGNING
#
# Android will not install an unsigned APK, so the build is always signed.
# With a keystore it is signed with yours, and each release installs over
# the last:
#
#   ANDROID_KEYSTORE            path to a .jks or .p12
#   ANDROID_KEYSTORE_PASSWORD
#   ANDROID_KEY_ALIAS
#   ANDROID_KEY_PASSWORD        defaults to the keystore password
#
# Without one, a key is generated for this build alone and thrown away. The
# APK installs, but Android treats the next build -- signed with a different
# throwaway key -- as a different app, so it has to be uninstalled first.
# CI's release notes say which of the two a release got.

set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${OPENOTES_VERSION:-$(node -p "require('./package.json').version")}"
export OPENOTES_VERSION="$VERSION"
OUTPUT_DIR="${OUTPUT_DIR:-dist}"
OUTPUT="$OUTPUT_DIR/Openotes-$VERSION-android.apk"

if [ -z "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" ]; then
  echo "ANDROID_HOME is not set; install the Android SDK first." >&2
  exit 1
fi
SDK="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"
BUILD_TOOLS=$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1)
if [ -z "$BUILD_TOOLS" ] || [ ! -x "$BUILD_TOOLS/apksigner" ]; then
  echo "No Android build-tools with apksigner under $SDK/build-tools." >&2
  exit 1
fi

echo "Generating the native project for $VERSION…"
rm -rf android
npx expo prebuild --platform android --no-install

echo "Building the release APK…"
(cd android && ./gradlew --no-daemon --quiet assembleRelease)

BUILT=$(ls android/app/build/outputs/apk/release/*.apk | head -1)
if [ -z "$BUILT" ]; then
  echo "Gradle produced no APK." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT"

if [ -n "${ANDROID_KEYSTORE:-}" ]; then
  echo "Signing with the configured keystore…"
  KEYSTORE="$ANDROID_KEYSTORE"
  KS_PASS="${ANDROID_KEYSTORE_PASSWORD:?ANDROID_KEYSTORE_PASSWORD is required with ANDROID_KEYSTORE}"
  ALIAS="${ANDROID_KEY_ALIAS:?ANDROID_KEY_ALIAS is required with ANDROID_KEYSTORE}"
  KEY_PASS="${ANDROID_KEY_PASSWORD:-$KS_PASS}"
  SIGNED_WITH="the configured keystore"
else
  echo "No keystore configured; signing with a key generated for this build only."
  KEYSTORE=$(mktemp -d)/throwaway.jks
  KS_PASS=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')
  ALIAS=openotes
  KEY_PASS="$KS_PASS"
  keytool -genkeypair -v -keystore "$KEYSTORE" -storepass "$KS_PASS" \
    -keypass "$KEY_PASS" -alias "$ALIAS" -keyalg RSA -keysize 2048 \
    -validity 10000 -dname "CN=Openotes throwaway build key" >/dev/null 2>&1
  SIGNED_WITH="a throwaway key"
fi

# apksigner replaces the template's debug signature outright, and keeps the
# alignment Gradle already applied.
"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE" --ks-pass "pass:$KS_PASS" \
  --ks-key-alias "$ALIAS" --key-pass "pass:$KEY_PASS" \
  --out "$OUTPUT" "$BUILT"
"$BUILD_TOOLS/apksigner" verify --print-certs "$OUTPUT" | head -3

if [ -n "${ANDROID_KEYSTORE:-}" ]; then :; else rm -f "$KEYSTORE"; fi

echo "  -> $OUTPUT (signed with $SIGNED_WITH)"
