import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = '@vibesdr_default_instance';

export interface DefaultInstance {
  name: string;
  url:  string;
}

export async function getDefaultInstance(): Promise<DefaultInstance | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as DefaultInstance;
  } catch {
    return null;
  }
}

export async function setDefaultInstance(instance: DefaultInstance): Promise<void> {
  await AsyncStorage.setItem(KEY, JSON.stringify(instance));
}

export async function clearDefaultInstance(): Promise<void> {
  await AsyncStorage.removeItem(KEY);
}
