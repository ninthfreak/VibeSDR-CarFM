// Render-error boundary — companion to services/crashGuard.ts. A flaky server
// can feed our components malformed state that throws during render; without a
// boundary RN unmounts the whole tree (white screen) or aborts. This catches
// the render throw, records it (same breadcrumb as the global handler), and
// remounts the navigation tree fresh — which lands back on the instance picker
// (initialRouteName) — then shows a server-attributed message.

import React from 'react';
import { Alert, View } from 'react-native';
import { recordCrash } from '../services/crashGuard';

type Props = { children: React.ReactNode };
type State = { hasError: boolean };

export default class CrashBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: any) {
    const info = recordCrash(error, 'render');
    // Remount the tree on the next tick (back to the picker), then warn.
    setTimeout(() => {
      this.setState({ hasError: false });
      Alert.alert(
        'Server connection lost',
        'The SDR server stopped responding — SDR servers (OpenWebRX especially) '
        + 'restart from time to time. This is a server issue, not a problem with '
        + 'VibeSDR. You’ve been returned to the server list.\n\n(detail: '
        + info.message + ')',
      );
    }, 50);
  }

  render() {
    if (this.state.hasError) return <View style={{ flex: 1, backgroundColor: '#0A0A12' }} />;
    return this.props.children;
  }
}
