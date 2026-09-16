// DEV ONLY — Node loader hook: any import of src/auth.js resolves to the dev stub.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register(new URL('data:text/javascript,' + encodeURIComponent(`
  const STUB = ${JSON.stringify(pathToFileURL(new URL('./dev-auth-stub.ts', import.meta.url).pathname).href)};
  export async function resolve(specifier, context, next) {
    if (/\\/src\\/auth\\.js$/.test(specifier) || specifier === '../auth.js' || specifier === '../src/auth.js') {
      return { url: STUB, shortCircuit: true };
    }
    return next(specifier, context);
  }
`)), import.meta.url);
