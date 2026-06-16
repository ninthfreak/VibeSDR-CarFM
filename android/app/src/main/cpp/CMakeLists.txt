# VibeSDR V4 — local-SDR shim, Stage 1 (NDK/CMake skeleton).
#
# Builds SDR++ Brown's `sdrpp_core` + the `rtl_sdr_source` module headless-ish
# into the VibeSDR APK (arm64-v8a / armeabi-v7a), plus a tiny JNI load-proof
# library. We deliberately DO NOT use SDR++'s root CMakeLists.txt — it also
# builds the `sdrpp` NativeActivity executable and several unconditional modules
# (brown_audio_sink, websdr_view, reports_monitor) we don't want. Instead this
# wrapper replicates just the root preamble those two targets rely on.
#
# Prebuilt native deps (volk/fftw3f/zstd/libusb/librtlsdr) come from the
# android-sdr-kit, extracted to ./sdr-kit/<ABI>/{include,lib}.

cmake_minimum_required(VERSION 3.22)
project(vibelocalsdr)

# --- Locations ---------------------------------------------------------------
# SDR++ Brown source. Defaults to the local Reference/ checkout (gitignored);
# override with -DSDRPP_SRC_ROOT=… for CI / a vendored copy later.
if (NOT DEFINED SDRPP_SRC_ROOT)
    set(SDRPP_SRC_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../Reference/SDRPlusPlusBrown-master")
endif()
get_filename_component(SDRPP_SRC_ROOT "${SDRPP_SRC_ROOT}" ABSOLUTE)

set(SDR_KIT_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/sdr-kit" CACHE PATH "Prebuilt SDR deps root")

if (NOT EXISTS "${SDRPP_SRC_ROOT}/core/CMakeLists.txt")
    message(FATAL_ERROR
        "SDR++ Brown source not found at:\n  ${SDRPP_SRC_ROOT}\n"
        "Set -DSDRPP_SRC_ROOT to the SDRPlusPlusBrown-master checkout.")
endif()
if (NOT EXISTS "${SDR_KIT_ROOT}/${ANDROID_ABI}/lib/libvolk.so")
    message(FATAL_ERROR "sdr-kit missing for ABI '${ANDROID_ABI}' at ${SDR_KIT_ROOT}")
endif()

# --- SDR++ build options (consumed by core/CMakeLists.txt) -------------------
set(OPT_BACKEND_GLFW    OFF CACHE BOOL "" FORCE)
set(OPT_BACKEND_ANDROID ON  CACHE BOOL "" FORCE)

# --- Root-preamble vars that core + sdrpp_module.cmake expect ----------------
set(SDRPP_MODULE_CMAKE "${SDRPP_SRC_ROOT}/sdrpp_module.cmake")
set(SDRPP_CORE_ROOT    "${SDRPP_SRC_ROOT}/core/src/")

# Release compiler flags (mirrors SDRPlusPlusBrown/CMakeLists.txt, Clang branch)
set(SDRPP_COMPILER_FLAGS -O3 -std=c++17 -Wno-unused-command-line-argument -Wno-deprecated-register)
set(SDRPP_MODULE_COMPILER_FLAGS ${SDRPP_COMPILER_FLAGS})

# Android toolchain flags (mirrors the `if (ANDROID)` block in the root file)
set(CMAKE_SHARED_LINKER_FLAGS "${CMAKE_SHARED_LINKER_FLAGS} -u ANativeActivity_onCreate")
set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 14)
set(CMAKE_CXX14_EXTENSION_COMPILE_OPTION "-std=c++17")

# --- Build core + the RTL-SDR source module only ----------------------------
add_subdirectory("${SDRPP_SRC_ROOT}/core" sdrpp_core_build)
add_subdirectory("${SDRPP_SRC_ROOT}/source_modules/rtl_sdr_source" rtl_sdr_source_build)

# --- VibeSDR local-SDR shim -------------------------------------------------
# Stage 2: opens an RTL-SDR from a USB fd via librtlsdr (rtlsdr_open_sys_dev).
# Include the radio module's RDS decoder source (FM RDS = station name etc.).
# Brown OMLSA/MCRA audio noise reduction (GPLv3, same as SDR++ Brown core).
file(GLOB NR_SRC
    "${CMAKE_CURRENT_SOURCE_DIR}/nr/omlsa_mcra.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/nr/omlsa_mcra/*.cpp")

# ft8_lib (kgoba, MIT) — FT8/FT4 core, built with self-contained KISS FFT.
file(GLOB FT8_LIB_SRC
    "${CMAKE_CURRENT_SOURCE_DIR}/ft8_lib/ft8/*.c"
    "${CMAKE_CURRENT_SOURCE_DIR}/ft8_lib/fft/kiss_fft.c"
    "${CMAKE_CURRENT_SOURCE_DIR}/ft8_lib/fft/kiss_fftr.c"
    "${CMAKE_CURRENT_SOURCE_DIR}/ft8_lib/common/monitor.c")

add_library(vibelocalsdr SHARED
    vibe_localsdr_jni.cpp local_sdr_shim.cpp
    decoders/fsk_decoder.cpp
    decoders/wefax_decoder.cpp
    decoders/ft8_decoder.cpp
    decoders/sstv_decoder.cpp
    ${NR_SRC}
    ${FT8_LIB_SRC}
    "${SDRPP_SRC_ROOT}/decoder_modules/radio/src/rds.cpp")
# ft8_lib (upstream kgoba) uses KISS FFT unconditionally — no extra define needed.
# core headers (dsp/stream, iq_frontend) need C++17; the global CMAKE_CXX_STANDARD
# is 14 (mirrors SDR++ root), so force this target like core forces its own.
set_target_properties(vibelocalsdr PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON CXX_EXTENSIONS OFF)
target_compile_options(vibelocalsdr PRIVATE -std=c++17)
target_include_directories(vibelocalsdr PRIVATE
    "${SDRPP_SRC_ROOT}/core/src"
    "${SDRPP_SRC_ROOT}/decoder_modules/radio/src"
    "${CMAKE_CURRENT_SOURCE_DIR}/ft8_lib"
    "${CMAKE_CURRENT_SOURCE_DIR}/nr"
    "${CMAKE_CURRENT_SOURCE_DIR}/nr/omlsa_mcra"
    "${SDR_KIT_ROOT}/${ANDROID_ABI}/include")
# --no-as-needed keeps the DT_NEEDED on libsdrpp_core.so so loading the shim
# actually pulls the SDR++ core in (proves the link, not just that it compiled).
target_link_libraries(vibelocalsdr PRIVATE
    -Wl,--no-as-needed sdrpp_core -Wl,--as-needed
    "${SDR_KIT_ROOT}/${ANDROID_ABI}/lib/librtlsdr.so"
    log)
