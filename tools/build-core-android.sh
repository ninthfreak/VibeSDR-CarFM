#!/usr/bin/env bash
# Cross-compile the portable core for Android and drop the .so where Gradle
# already looks.
#
# This is NOT part of the Gradle build, on purpose. Wiring cargo into Gradle
# would make an Android toolchain a hard requirement for every build, including
# CI, which today needs neither. The cost of that choice is that the .so is only
# present if you have run this script — which is exactly why CarfmCore.kt treats
# the library as optional and degrades to the JavaScript decoder when it is
# missing. If the core ever becomes load-bearing rather than a shadow, this has
# to become a Gradle task instead.
#
#   ./tools/build-core-android.sh            # release, both ABIs
#   ./tools/build-core-android.sh --debug    # keeps overflow checks (see below)
#
# Requires: rustup, the Android NDK, and cargo-ndk
#   rustup target add armv7-linux-androideabi aarch64-linux-android
#   cargo install cargo-ndk
#   export ANDROID_NDK_HOME=~/Android/Sdk/ndk/<version>
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$PWD"
# ABSOLUTE, because the build runs from core/ (see below) — a relative path would
# resolve against the wrong directory and silently write the .so somewhere Gradle
# never looks. AGP's default jniLibs dir, so no Gradle change is needed.
OUT="$REPO/android/app/src/main/jniLibs"

PROFILE_ARGS=(--release)
PROFILE_NAME="release"
if [[ "${1:-}" == "--debug" ]]; then
  PROFILE_ARGS=()
  PROFILE_NAME="debug"
fi

# Ask CARGO whether the subcommand works, rather than looking for cargo-ndk on
# PATH. `cargo install` drops binaries in $CARGO_HOME/bin, and cargo resolves
# `cargo <sub>` from there whether or not that directory is on PATH — so a PATH
# probe reports "not found" for a perfectly working install. That is exactly what
# it did on a Pop!_OS box with cargo from apt in /usr/bin and cargo-ndk in
# ~/.cargo/bin: the tool was installed, the script refused to run.
if ! cargo ndk --version >/dev/null 2>&1; then
  echo "cargo-ndk not usable. Install it with: cargo install cargo-ndk" >&2
  echo "(already installed? check it runs: cargo ndk --version)" >&2
  exit 1
fi
# Find the NDK if it was not exported. Newest side-by-side install wins, under
# whichever SDK root is set — the layout `sdkmanager --install "ndk;…"` produces.
#
# ANY reasonably recent NDK works. carfm-jni is pure Rust with no C++ interop —
# it does not link libc++_shared or touch the STL — so the usual reason to match
# the NDK Gradle uses (STL linkage) does not apply here. Gradle's own version is
# pinned separately by React Native (27.1.12297006 in
# node_modules/react-native/gradle/libs.versions.toml) and the two need not agree.
# Keep cargo-ndk current instead: it is the piece that has to understand the
# NDK's toolchain layout, and that layout changes between releases.
if [[ -z "${ANDROID_NDK_HOME:-}" && -z "${NDK_HOME:-}" && -z "${ANDROID_NDK_ROOT:-}" ]]; then
  for sdk in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Android/Sdk" "$HOME/Library/Android/sdk"; do
    [[ -n "$sdk" && -d "$sdk/ndk" ]] || continue
    found=$(ls -1 "$sdk/ndk" 2>/dev/null | sort -V | tail -1)
    if [[ -n "$found" ]]; then
      export ANDROID_NDK_HOME="$sdk/ndk/$found"
      echo "Using NDK $found (found under $sdk/ndk)"
      break
    fi
  done
fi
if [[ -z "${ANDROID_NDK_HOME:-}" && -z "${NDK_HOME:-}" && -z "${ANDROID_NDK_ROOT:-}" ]]; then
  cat >&2 <<'MSG'
No Android NDK found.

Install one — any recent version is fine for this library. Android Studio:
SDK Manager -> SDK Tools -> Show Package Details -> NDK (Side by side).
Or, if you have the command-line tools:  sdkmanager --install "ndk;<version>"

Then re-run this script (it looks under $ANDROID_HOME/ndk, $ANDROID_SDK_ROOT/ndk
and ~/Android/Sdk/ndk), or set ANDROID_NDK_HOME yourself.
MSG
  exit 1
fi

# The two ABIs android/gradle.properties builds for (reactNativeArchitectures).
# Keep this list in step with that one.
# RUN FROM core/, not the repo root. cargo-ndk loads `cargo metadata` from the
# CURRENT DIRECTORY before it forwards anything to cargo, so --manifest-path does
# not save it: at the repo root — which has no Cargo.toml, the workspace being in
# core/ — it fails with "could not find Cargo.toml in ... or any parent directory"
# before the build starts.
cd core
echo "Building carfm-jni ($PROFILE_NAME) for armeabi-v7a + arm64-v8a…"
cargo ndk -t armeabi-v7a -t arm64-v8a -o "$OUT" \
  build -p carfm-jni "${PROFILE_ARGS[@]}"

echo
echo "Wrote:"
find "$OUT" -name 'libcarfm_jni.so' -exec ls -la {} \;
echo
echo "The release profile has overflow-checks OFF (cargo's default), which is how"
echo "the segment-15 shift bug produced wrong output instead of a crash. Build with"
echo "--debug if you would rather a decoder overflow be loud on the device."
