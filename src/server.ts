/**
 * canton-backend-lambda — express server (devnet branch).
 *
 * Local dev: standalone Express on PORT.
 * Production: the same `app` is exported for the AWS Lambda wrapper in
 *             src/index.ts when AWS_LAMBDA_FUNCTION_NAME is set.
 */

import express from 'express';
import cors from 'cors';
import routes from './routes.js';
import signupRoutes from './signup.js';
import meRoutes from './api/me.js';
import kycRoutes from './api/kyc.js';
import { PORT, CORS_ORIGINS } from './config.js';

const app = express();

app.use(cors({ origin: CORS_ORIGINS, credentials: true }));

// KYC webhook must read the raw body for HMAC verification — so we mount
// the KYC router BEFORE the global JSON parser. The webhook handler inside
// uses express.raw() locally; /kyc/start parses JSON via the global parser
// below because that mount comes second.
app.use('/', kycRoutes);

// Everything else gets JSON parsing.
app.use(express.json());
app.use('/', routes);
app.use('/', signupRoutes);
app.use('/', meRoutes);

if (process.env.AWS_LAMBDA_FUNCTION_NAME === undefined) {
  app.listen(PORT, () => {
    console.log(`canton-backend-lambda (devnet) on http://localhost:${PORT}`);
    console.log('  GET  /health');
    console.log('  POST /signup                — validator onboarding (invite-code gated)');
    console.log('  POST /validate-invite');
    console.log('  GET  /me                    — caller profile + KYC status');
    console.log('  GET  /holdings              — on-chain Amulet/CC holdings');
    console.log('  GET  /deposit-receipts      — operator-signed DepositRecords');
    console.log('  POST /kyc/start             — create a Persona inquiry');
    console.log('  POST /kyc/webhook           — Persona event sink (HMAC verified)');
    console.log('  GET  /admin/invite-codes    — admin (x-api-key)');
  });
}

export { app };
export default app;
