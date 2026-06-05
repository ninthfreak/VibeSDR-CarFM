import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { StatusBar } from 'expo-status-bar';

import ViewPickerScreen    from './src/screens/ViewPickerScreen';
import InstancePickerScreen from './src/screens/InstancePickerScreen';
import SDRScreen            from './src/screens/SDRScreen';
import WebViewerScreen      from './src/screens/WebViewerScreen';
import { ViewMode } from './src/services/viewMode';

export type RootStackParamList = {
  ViewPicker:     undefined;
  InstancePicker: undefined;
  SDR:        { baseUrl: string; password?: string; instanceName?: string; viewMode: ViewMode };
  WebViewer:  { url: string; title?: string };
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  return (
    <NavigationContainer>
      <StatusBar style="light" />
      <Stack.Navigator
        initialRouteName="InstancePicker"
        screenOptions={{
          headerStyle:      { backgroundColor: '#0A0A12' },
          headerTintColor:  '#FFB833',
          headerTitleStyle: { fontFamily: 'Courier' },
          contentStyle:     { backgroundColor: '#0A0A12' },
          animation:        'fade',
        }}
      >
        <Stack.Screen
          name="ViewPicker"
          component={ViewPickerScreen}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="InstancePicker"
          component={InstancePickerScreen}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="SDR"
          component={SDRScreen}
          options={{ headerShown: false, gestureEnabled: false }}
        />
        <Stack.Screen
          name="WebViewer"
          component={WebViewerScreen}
          options={{ headerShown: false, gestureEnabled: true }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
