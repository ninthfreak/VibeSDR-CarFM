Pod::Spec.new do |s|
  s.name         = 'VibeLocalSDR'
  s.version      = '1.0.0'
  s.summary      = 'VibeSDR local-SDR shim (RTL-TCP) for iOS — clean-room VibeDSP engine.'
  s.homepage     = 'https://github.com/Stuey3D/VibeSDR'
  s.license      = { :type => 'GPLv3' }
  s.author       = 'VibeSDR'
  s.platform     = :ios, '16.4'
  s.source       = { :path => '.' }

  s.source_files = '*.{mm,h}'

  # V5: a single GPL-FREE static lib (the clean-room VibeDSP engine + shim,
  # KissFFT BSD-3). SDR++ Brown / FFTW / VOLK / zstd are GONE — that's the whole
  # point of V5 (App-Store-clean while keeping RTL-TCP on iOS).
  # Rebuild with ./build_ios.sh after changing any native source.
  s.vendored_libraries = 'libs/libvibelocalsdr_ios.a'

  s.frameworks = 'CoreFoundation', 'Security', 'CFNetwork', 'AudioToolbox'
  s.libraries  = 'c++'

  s.dependency 'React-Core'

  s.pod_target_xcconfig = {
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'CLANG_CXX_LIBRARY' => 'libc++',
    # Compile VibeLocalSDR.mm against the CANONICAL shim header in the shared
    # native tree — the same file build_ios.sh compiles the static lib from.
    # There used to be a hand-copied duplicate in ./include, which silently went
    # stale whenever the shim's API changed: the .a had the new symbol, the .mm
    # was compiled against the old header, and the iOS archive failed (or worse,
    # would have linked against a mismatched ABI). One header, no copies.
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/../../android/app/src/main/cpp"',
    'OTHER_LDFLAGS' => '-ObjC',
  }
end
