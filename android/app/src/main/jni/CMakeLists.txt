# VibeSDR app native build entry point.
#
# React Native's New Architecture needs its own CMake (builds libappmodules.so,
# which registers the core TurboModules like PlatformConstants). Setting a custom
# externalNativeBuild path REPLACES RN's default, so we must include RN's setup
# here ourselves and then add the V4 local-SDR shim alongside it.
#
# Based on react-native/ReactAndroid/cmake-utils/default-app-setup/CMakeLists.txt.

cmake_minimum_required(VERSION 3.22)

project(appmodules)

# React Native application setup (libappmodules.so + autolinked TurboModules).
include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)

# V4 local-SDR shim (SDR++ Brown core + rtl_sdr + WS server). Lives in ../cpp;
# builds libvibelocalsdr.so (+ libsdrpp_core.so / rtl_sdr_source.so), packaged
# into the APK and loaded on demand by VibeLocalSDR.kt.
add_subdirectory(${CMAKE_CURRENT_SOURCE_DIR}/../cpp vibelocalsdr_build)
