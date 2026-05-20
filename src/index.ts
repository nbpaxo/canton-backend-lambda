/**
 * AWS Lambda entry — bridges API Gateway proxy events into our Express
 * app from `server.ts`. Single source of truth: local dev uses `npm run
 * dev` (Express on PORT), production uses this file as the Lambda handler
 * pointed at by `index.handler`.
 *
 * `server.ts` exports the configured Express `app` and skips its own
 * `app.listen()` when `AWS_LAMBDA_FUNCTION_NAME` is set (which AWS
 * Lambda always sets), so the same module is safe to import here.
 *
 * The previous 600-line direct-Lambda handler from the localnet phase
 * lives in `src/index.legacy-localnet.ts.bak` for reference — it's no
 * longer wired into the build.
 */
import serverless from 'serverless-http';
import { app } from './server.js';

export const handler = serverless(app);
