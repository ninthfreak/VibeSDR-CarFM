// GLOBAL POLYFILL, FIRST. crypto.getRandomValues does not exist on Hermes, and
// uuid needs it — AudioPlayer calls uuidv4() for the session id.
//
// This lived in UberSDRClient, where it only ever worked by accident: RadioScreen
// imported that module eagerly, so the side effect ran before anything asked for
// a uuid. Enabling inline requires deferred UberSDRClient to its use site, which
// on the built-in tuner is never reached, so the polyfill stopped installing and
// the app crashed on first launch with "property 'crypto' doesn't exist".
//
// The entry point is where a global polyfill belongs: unconditional, before the
// app is registered, and impossible to defer.
import 'react-native-get-random-values';

// TUNER SECOND. Nothing above needs it and nothing below should wait for it: the
// bind and the audio claim are fired here so they are in flight while React is
// still starting, instead of queueing behind fonts, the picker and a navigation.
// Fire-and-forget on purpose — awaiting it would put the bind back in front of
// first paint, which is the delay being removed.
import { warmStartNwd } from './src/services/nwdWarmStart';

import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
warmStartNwd();

registerRootComponent(App);
