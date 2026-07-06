#!/bin/sh
# Xcode Cloud post-clone step for VibeSDR (Expo / React Native bare workflow).
#
# Xcode Cloud runs this immediately after cloning the repo, before resolving
# dependencies. It installs Node + the JS deps + CocoaPods so the archive can
# run the "Bundle React Native code and images" phase and link the pods.
#
# WHY XCODE CLOUD: our local build machine is on a BETA macOS (27.x), and App
# Store Connect rejects binaries built on a beta OS (ITMS-90111), even with the
# stable Xcode 26.6. Xcode Cloud builds on Apple's stable macOS images, so it
# produces an acceptable binary. Keep using this until macOS 27 ships stable.
set -e

echo "--- ci_post_clone: installing Node via Homebrew ---"
# Xcode Cloud images ship Homebrew but not Node. Install the current Node.
brew install node

echo "--- node/npm versions ---"
node --version
npm --version

# CI_PRIMARY_REPOSITORY_PATH = the cloned repo root (set by Xcode Cloud).
cd "$CI_PRIMARY_REPOSITORY_PATH"

echo "--- installing JS dependencies (npm ci) ---"
# npm ci for a clean, lockfile-exact install; fall back to npm install if the
# lockfile is out of sync so a first run never hard-fails on drift.
npm ci || npm install

echo "--- installing CocoaPods ---"
cd "$CI_PRIMARY_REPOSITORY_PATH/ios"
# Xcode Cloud images include CocoaPods; use the repo's setup as-is (bare
# workflow — ios/ is committed, so NO expo prebuild).
pod install

echo "--- ci_post_clone: done ---"
