/** DEV ONLY — stand-in for src/auth.ts: requireAuth injects a chosen party. */
import type { Request, Response, NextFunction } from 'express';

let party = process.env.TEST_PARTY ?? 'dev::1220';
export function setDevParty(p: string): void { party = p; }

export interface AuthenticatedRequest extends Request { user: { party: string } }

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  (req as AuthenticatedRequest).user = { party };
  next();
}
