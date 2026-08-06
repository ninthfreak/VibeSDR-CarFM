const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Bundle the offline station database (assets/db/stations.sqlite) as an asset so
// require() resolves it and expo-asset can copy it to the SQLite dir at runtime.
config.resolver = config.resolver ?? {};
config.resolver.assetExts = [...(config.resolver.assetExts ?? []), 'sqlite', 'db'];

// Reanimated v4, react-native-worklets, and Skia ship with raw 'worklet'
// directives that must pass through the Babel/worklets plugin.
// Extend Metro's transform ignore pattern to include these packages.
config.transformer = config.transformer ?? {};
config.transformer.transformIgnorePatterns = [
  'node_modules/(?!(' +
  [
    'react-native',
    '@react-native',
    '@react-navigation',
    'expo',
    '@expo',
    'react-native-reanimated',
    '@shopify/react-native-skia',
    'react-native-gesture-handler',
    'react-native-screens',
    'react-native-safe-area-context',
    '@react-native-async-storage',
    'react-native-get-random-values',
    'expo-keep-awake',
    'uuid',
  ].join('|') +
  ')/)',
];

// INLINE REQUIRES. Off by default, and the single biggest startup lever here:
// without it every top-level require in a module executes the moment that module
// loads, so pulling in RadioScreen executes all 48 of its imports and their whole
// dependency trees before anything renders. That includes the entire SDR client
// stack — UberSDRClient and the backend adapter — which the built-in NWD tuner
// never touches, executed on every launch to serve a dongle that is not plugged
// in. With this on, Metro rewrites those requires into inline calls at first use
// and a module that is never touched never runs.
//
// Wrapped rather than replaced: the default getTransformOptions carries other
// keys, and clobbering it would silently drop them.
const baseGetTransformOptions = config.transformer.getTransformOptions;
config.transformer.getTransformOptions = async (...args) => {
  const base = baseGetTransformOptions ? await baseGetTransformOptions(...args) : {};
  return {
    ...base,
    transform: { ...(base.transform ?? {}), inlineRequires: true },
  };
};

module.exports = config;
