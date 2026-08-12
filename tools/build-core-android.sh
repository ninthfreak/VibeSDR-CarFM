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
OUT="android/app/src/main/jniLibs"     # AGP's default jniLibs dir; no Gradle change needed

PROFILE_ARGS=(--release)
PROFILE_NAME="release"
if [[ "${1:-}" == "--debug" ]]; then
  PROFILE_ARGS=()
  PROFILE_NAME="debug"
fi

if ! command -v cargo-ndk >/dev/null 2>&1; then
  echo "cargo-ndk not found. Install it with: cargo install cargo-ndk" >&2
  exit 1
fi
# Find the NDK if it was not exported. Newest side-by-side install wins, under
# whichever SDK root is set — this is the layout `sdkmanager --install "ndk;…"`
# produces, and having to export a path by hand every session is friction for no
# reason. React Native 0.86 pins 27.1.12297006 (node_modules/react-native/gradle/
# libs.versions.toml); cargo-ndk is not fussy, but matching Gradle avoids
# surprises.
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

  sdkmanager --install "ndk;27.1.12297006"      # the version RN 0.86 pins

then either re-run this script (it looks under $ANDROID_HOME/ndk and
~/Android/Sdk/ndk), or set ANDROID_NDK_HOME yourself.
MSG
  exit 1
fi

# The two ABIs android/gradle.properties builds for (reactNativeArchitectures).
# Keep this list in step with that one.
echo "Building carfm-jni ($PROFILE_NAME) for armeabi-v7a + arm64-v8a…"
cargo ndk -t armeabi-v7a -t arm64-v8a -o "$OUT" \
  build -p carfm-jni --manifest-path core/Cargo.toml "${PROFILE_ARGS[@]}"

echo
echo "Wrote:"
find "$OUT" -name 'libcarfm_jni.so' -exec ls -la {} \;
echo
echo "The release profile has overflow-checks OFF (cargo's default), which is how"
echo "the segment-15 shift bug produced wrong output instead of a crash. Build with"
echo "--debug if you would rather a decoder overflow be loud on the device."
