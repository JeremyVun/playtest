#!/usr/bin/env bash
#
# Build the SwiftUI todo fixture for the iOS Simulator.
#
# No Xcode project and no code signing: simulator apps run unsigned, so this
# compiles the sources with `xcrun swiftc` against the iphonesimulator SDK and
# assembles the .app bundle by hand. Rerunnable, quiet on success, and the last
# line of stdout is the absolute path of the built .app.
#
set -euo pipefail

FIXTURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${FIXTURE_DIR}/build"
APP_DIR="${BUILD_DIR}/TodoFixture.app"

# arm64 by default; override for an Intel host with TODO_FIXTURE_ARCH=x86_64.
ARCH="${TODO_FIXTURE_ARCH:-$(uname -m)}"
DEPLOYMENT_TARGET="17.0"

SDK_PATH="$(xcrun --sdk iphonesimulator --show-sdk-path)"

rm -rf "${APP_DIR}"
mkdir -p "${APP_DIR}"

xcrun --sdk iphonesimulator swiftc \
	-target "${ARCH}-apple-ios${DEPLOYMENT_TARGET}-simulator" \
	-sdk "${SDK_PATH}" \
	-emit-executable \
	-parse-as-library \
	-O \
	-o "${APP_DIR}/TodoFixture" \
	"${FIXTURE_DIR}"/Sources/*.swift

cp "${FIXTURE_DIR}/Info.plist" "${APP_DIR}/Info.plist"

# simctl reads the binary plist form fine, but normalising keeps `plutil -p`
# output stable for anyone inspecting the bundle.
plutil -convert binary1 "${APP_DIR}/Info.plist"

echo "${APP_DIR}"
