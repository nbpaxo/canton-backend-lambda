/**
 * canton-backend-lambda — express server (devnet branch).
 *
 * Local dev: standalone Express on PORT.
 * Production: the same `app` is exported for the AWS Lambda wrapper in
 *             src/index.ts when AWS_LAMBDA_FUNCTION_NAME is set.
 */

import express, {
  type ErrorRequestHandler,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import cors from 'cors';
import routes from './routes.js';
import signupRoutes from './signup.js';
import meRoutes from './api/me.js';
import kycRoutes from './api/kyc.js';
import depositsRoutes from './api/deposits.js';
import internalDepositRoutes from './api/internalDeposit.js';
import withdrawRoutes from './api/withdraw.js';
import withdrawalsRoutes from './api/withdrawals.js';
import { PORT, CORS_ORIGINS } from './config.js';

// ─── Cold-start banner ───────────────────────────────────────────────────
// Logged once per Lambda container init (= once per cold start). Gives
// CloudWatch a single grep-able anchor line per fresh container so we can
// correlate subsequent request logs to the right environment + commit.
// Use console.log (not console.info) — every Lambda Node runtime guarantees
// stdout capture; some older runtimes drop info-level by default.
console.log(JSON.stringify({
  level: 'info',
  type: 'cold_start',
  at: new Date().toISOString(),
  function: process.env.AWS_LAMBDA_FUNCTION_NAME ?? 'local',
  region: process.env.AWS_REGION ?? 'unknown',
  // host of the DATABASE_URL (no creds) — handy when pointing at the
  // wrong RDS instance is the actual bug.
  databaseHost: process.env.DATABASE_URL?.match(/@([^:/]+)/)?.[1] ?? '<unset>',
  authMode: process.env.AUTH_MODE ?? 'open',
}));

// Surface any error that escapes the Express pipeline — these would
// otherwise crash the container silently between invocations.
process.on('uncaughtException', (err) => {
  console.error(JSON.stringify({
    level: 'fatal',
    type: 'uncaughtException',
    message: err.message,
    stack: err.stack,
  }));
});
process.on('unhandledRejection', (reason) => {
  console.error(JSON.stringify({
    level: 'fatal',
    type: 'unhandledRejection',
    reason: reason instanceof Error
      ? { message: reason.message, stack: reason.stack }
      : String(reason),
  }));
});

const app = express();

app.use(cors({ origin: CORS_ORIGINS, credentials: true }));

// ─── Request logger ──────────────────────────────────────────────────────
// One line per request, written when the response finishes. Structured
// JSON so CloudWatch Logs Insights can query it directly (eg.
// `filter type="request" and status>=400 | sort @timestamp desc`).
// Mounted BEFORE any router so 404s are also captured.
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(JSON.stringify({
      level: 'info',
      type: 'request',
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - start,
      // X-Amzn-Trace-Id is set by API Gateway; fall back to anything the
      // caller forwarded so log lines can be correlated end-to-end.
      requestId:
        (req.headers['x-amzn-trace-id'] as string | undefined)
        ?? (req.headers['x-request-id'] as string | undefined)
        ?? '',
      // x-party-id is the open-auth identifier our endpoints use.
      partyId: (req.headers['x-party-id'] as string | undefined) ?? null,
      contentLength: Number(res.getHeader('content-length') ?? 0),
    }));
  });
  next();
});

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
app.use('/', depositsRoutes);
app.use('/', internalDepositRoutes);
app.use('/', withdrawRoutes);
app.use('/', withdrawalsRoutes);

// ─── 404 + error handlers (JSON, never HTML) ─────────────────────────────
// Express's default handlers serve HTML, which trips up our frontend's
// JSON-only response parser. These two catch-alls guarantee every response
// from canton-backend is `application/json` regardless of what blew up.

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'not_found', method: req.method, path: req.path });
});

const jsonErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) {
    // eslint-disable-next-line no-console
    console.warn('[server] error after headers sent — defaulting to Express handler:', err);
    return _next(err);
  }
  const e = err as { status?: number; statusCode?: number; message?: string; stack?: string };
  const status = e.status ?? e.statusCode ?? 500;
  // eslint-disable-next-line no-console
  console.error(`[server] ${req.method} ${req.path} → ${status}: ${e.message}\n${e.stack ?? ''}`);
  res.status(status).json({
    error: 'internal_server_error',
    message: e.message ?? 'unknown',
  });
};
app.use(jsonErrorHandler);

if (process.env.AWS_LAMBDA_FUNCTION_NAME === undefined) {
  app.listen(PORT, () => {
    console.log(`canton-backend-lambda (devnet) on http://localhost:${PORT}`);
    console.log('  GET  /health');
    console.log('  POST /signup                — validator onboarding (invite-code gated)');
    console.log('  POST /validate-invite');
    console.log('  GET  /me                    — caller profile + KYC status');
    console.log('  GET  /holdings              — on-chain Amulet/CC holdings');
    console.log('  GET  /deposit-receipts      — operator-signed DepositRecords');
    console.log('  GET  /deposits              — caller deposit history (credited + held)');
    console.log('  POST /kyc/start             — create a Persona inquiry');
    console.log('  POST /kyc/webhook           — Persona event sink (HMAC verified)');
    console.log('  GET  /admin/invite-codes    — admin (x-api-key)');
  });
}

export { app };
export default app;
