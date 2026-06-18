Pod::Spec.new do |s|
  s.name         = 'VibeLocalSDR'
  s.version      = '1.0.0'
  s.summary      = 'VibeSDR local-SDR shim (RTL-TCP) for iOS — SDR++ Brown core + shim.'
  s.homepage     = 'https://github.com/Stuey3D/VibeSDR'
  s.license      = { :type => 'GPLv3' }
  s.author       = 'VibeSDR'
  s.platform     = :ios, '16.4'
  s.source       = { :path => '.' }

  s.source_files = '*.{mm,h}'
  s.public_header_files = 'include/*.h'

  # Prebuilt static libs: the shim+core (libvibelocalsdr_ios) + its deps.
  s.vendored_libraries = 'libs/libvibelocalsdr_ios.a', 'libs/libvolk.a',
                         'libs/libfftw3f.a', 'libs/libzstd.a'

  s.frameworks = 'Accelerate', 'CoreFoundation', 'Security', 'CFNetwork', 'AudioToolbox'
  s.libraries  = 'c++'

  s.dependency 'React-Core'

  s.pod_target_xcconfig = {
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'CLANG_CXX_LIBRARY' => 'libc++',
    'HEADER_SEARCH_PATHS' => '"$(PODS_TARGET_SRCROOT)/include"',
    'OTHER_LDFLAGS' => '-ObjC',
  }
end
