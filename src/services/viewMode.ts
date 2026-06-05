import AsyncStorage from '@react-native-async-storage/async-storage';

export type ViewMode = 'default' | 'accessibility';
const KEY = '@vibesdr_view_mode';

export async function getViewMode(): Promise<ViewMode | null> {
  try {
    const v = await AsyncStorage.getItem(KEY);
    if (v === 'default' || v === 'accessibility') return v;
    return null;
  } catch { return null; }
}

export async function setViewMode(mode: ViewMode): Promise<void> {
  await AsyncStorage.setItem(KEY, mode);
}

export async function clearViewMode(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}

// Returns the lsv_prefs JSON to pre-set in localStorage so the skin
// applies the right mode without showing its own picker.
export function skinPrefsJson(mode: ViewMode): string {
  return JSON.stringify({ skinChosen: true, a11y: mode === 'accessibility' });
}
