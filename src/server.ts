/**
 * Canton backend lambda — express server.
 *
 * For local dev: runs as a standalone Express server.
 * For AWS Lambda: export the express app and wrap with serverless-express.
 */

import express from 'express';
import cors from 'cors';
import routes from './routes.js';
import signupRoutes from './signup.js';
import { PORT, CORS_ORIGINS } from './config.js';

const app = express();

// CORS — allow trading terminal origins
app.use(cors({
  origin: CORS_ORIGINS,
  credentials: true,
}));

app.use(express.json());

// Mount routes at root (no /api prefix — lambda paths map directly)
app.use('/', routes);
app.use('/', signupRoutes);

// Start server (for local dev)
if (process.env.AWS_LAMBDA_FUNCTION_NAME === undefined) {
  app.listen(PORT, () => {
    console.log(`Canton backend lambda running on http://localhost:${PORT}`);
    console.log(`  GET  /health`);
    console.log(`  POST /signup`);
    console.log(`  GET  /vault/status`);
    console.log(`  POST /vault/accept-proposal`);
    console.log(`  GET  /holdings`);
    console.log(`  GET  /deposit-receipts`);
    console.log(`  POST /faucet`);
    console.log(`  GET  /mint-proposals`);
    console.log(`  POST /mint-proposals/accept`);
    console.log(`  POST /deposit`);
    console.log(`  POST /withdraw`);
    console.log(`  GET  /admin/invite-codes`);
  });
}

// Export for Lambda handler wrapper
export { app };
export default app;
