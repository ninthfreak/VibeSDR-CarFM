// Lets a plain-node harness import the app's TypeScript modules directly.
//
// Node strips types from a `.ts` file happily, but it will not guess an
// extension: the app writes `import { haversineKm } from './stationGeo'`, the
// Metro/TypeScript convention, and node's ESM resolver wants './stationGeo.ts'.
// This hook retries an extensionless relative specifier as `.ts`, so harnesses
// import the SHIPPED modules rather than a copy of them — which is the point of
// a differential.
//
// Used as: node --import ./tools/tests/tsResolve.mjs <harness>
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const HOOK = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\\.[cm]?[jt]sx?$/i.test(specifier)) {
    try { return await nextResolve(specifier + '.ts', context); } catch { /* fall through */ }
  }
  return nextResolve(specifier, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(HOOK)}`, pathToFileURL('./'));
