/**
 * Per-IP rate limiting.
 *
 * CAVEAT, read before relying on this: state lives in the Lambda container,
 * so the budget is per warm container, not global. Concurrent containers each
 * get their own counters and a cold start resets them. It raises the cost of
 * casual scripted abuse; it is NOT a substitute for throttling at the edge.
 * The real control is an AWS WAF rate rule (or API Gateway usage plan) in
 * front of the function — this is defence in depth behind it.
 *
 * Client IP comes from X-Forwarded-For's left-most entry, which is what API
 * Gateway / the ALB puts there. A caller can spoof that header, so treat the
 * key as best-effort.
 */
import type { Request, Response, NextFunction } from 'express';

interface Bucket { count: number; resetAt: number; }

const buckets = new Map<string, Bucket>();
const MAX_KEYS = 20_000;

function clientKey(req: Request, scope: string): string {
  const xff = req.headers['x-forwarded-for'];
  const ip = (typeof xff === 'string' ? xff.split(',')[0].trim() : '')
    || req.socket.remoteAddress
    || 'unknown';
  return `${scope}:${ip}`;
}

/**
 * @param scope  label so different endpoint groups get separate budgets
 * @param limit  requests allowed per window
 * @param windowMs  window length
 */
export function rateLimit(scope: string, limit: number, windowMs: number) {
  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const key = clientKey(req, scope);
    const now = Date.now();

    // Cheap eviction — this map is bounded by container lifetime, and an
    // attacker rotating IPs would otherwise grow it without limit.
    if (buckets.size > MAX_KEYS) {
      for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
      if (buckets.size > MAX_KEYS) buckets.clear();
    }

    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count += 1;
    if (bucket.count > limit) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      // eslint-disable-next-line no-console
      console.warn(JSON.stringify({
        level: 'warn', type: 'rate_limited', scope, path: req.path, key, count: bucket.count,
      }));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'rate_limited', retryAfterSeconds: retryAfter });
      return;
    }
    next();
  };
}
