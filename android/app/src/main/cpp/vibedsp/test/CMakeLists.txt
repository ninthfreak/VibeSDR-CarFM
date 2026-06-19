# VibeSDR V5 DSP — HOST test harness (dev machine only, not part of the app build).
#   cmake -S . -B build && cmake --build build && ./build/vibedsp_tests
cmake_minimum_required(VERSION 3.18)
project(vibedsp_tests CXX C)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(DSP ${CMAKE_CURRENT_SOURCE_DIR}/..)

set(DSP_SRC
    ${DSP}/fft.cpp
    ${DSP}/ddc.cpp
    ${DSP}/resampler.cpp
    ${DSP}/stereo.cpp
    ${DSP}/rds.cpp
    ${DSP}/pipeline.cpp
    ${DSP}/third_party/kissfft/kiss_fft.c
    ${DSP}/third_party/kissfft/kiss_fftr.c
)

add_executable(vibedsp_tests test_fft.cpp ${DSP_SRC})
target_include_directories(vibedsp_tests PRIVATE ${DSP})
target_compile_options(vibedsp_tests PRIVATE -O2 -Wall)

add_executable(vibedsp_demod_tests test_demod.cpp ${DSP_SRC})
target_include_directories(vibedsp_demod_tests PRIVATE ${DSP})
target_compile_options(vibedsp_demod_tests PRIVATE -O2 -Wall)

add_executable(vibedsp_cfft_tests test_cfft.cpp ${DSP_SRC})
target_include_directories(vibedsp_cfft_tests PRIVATE ${DSP})
target_compile_options(vibedsp_cfft_tests PRIVATE -O2 -Wall)

add_executable(vibedsp_pipeline_tests test_pipeline.cpp ${DSP_SRC})
target_include_directories(vibedsp_pipeline_tests PRIVATE ${DSP})
target_compile_options(vibedsp_pipeline_tests PRIVATE -O2 -Wall)

add_executable(vibedsp_rds_tests test_rds.cpp ${DSP_SRC})
target_include_directories(vibedsp_rds_tests PRIVATE ${DSP})
target_compile_options(vibedsp_rds_tests PRIVATE -O2 -Wall)

add_executable(vibedsp_rds_dsp_tests test_rds_dsp.cpp ${DSP_SRC})
target_include_directories(vibedsp_rds_dsp_tests PRIVATE ${DSP})
target_compile_options(vibedsp_rds_dsp_tests PRIVATE -O2 -Wall)
