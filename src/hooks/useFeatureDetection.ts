import { useEffect, useState } from 'react';
import { EMPTY_FEATURES, FeatureSet, fetchExtensions } from '../services/ubersdrProtocol';

export function useFeatureDetection(baseUrl: string | null): FeatureSet {
  const [features, setFeatures] = useState<FeatureSet>(EMPTY_FEATURES);

  useEffect(() => {
    if (!baseUrl) return;
    fetchExtensions(baseUrl).then(setFeatures);
  }, [baseUrl]);

  return features;
}
