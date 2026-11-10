import type { RequestHandler, Response } from 'express';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Database, Sql } from './db.js';
import { config } from './config.js';
import { AppError } from './errors.js';
import type { Role, User } from '../shared/contracts.js';

export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');
export const secretToken = () => randomBytes(32).toString('base64url');
const key = new TextEncoder().encode(config.jwtSecret);
export const cookieOptions = {
  httpOnly: true,
  secure: config.production,
  sameSite: 'strict' as const,
  path: '/api/v1/auth',
  maxAge: 7 * 86400000,
};
export async function accessToken(user: User & { token_version: number }, sessionId: string) {
  return new SignJWT({ role: user.role, version: user.token_version, sid: sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer('sdp-inventory')
    .setAudience('sdp-web')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(key);
}
export async function newSession(tx: Sql, userId: string, familyId: string, res: Response) {
  const token = secretToken();
  const [session] = await tx.query(
    "INSERT INTO sessions(user_id,family_id,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '7 days') RETURNING id",
    [userId, familyId, hashToken(token)],
  );
  res.cookie('sdp_refresh', token, cookieOptions);
  return session.id as string;
}
export const csrf: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  const allowed = config.production
    ? [config.origin]
    : [config.origin, 'http://127.0.0.1:5173', 'http://localhost:5173'];
  const cookie = req.signedCookies.sdp_csrf;
  const header = req.get('x-csrf-token');
  if (
    !origin ||
    !allowed.includes(origin) ||
    typeof cookie !== 'string' ||
    !header ||
    cookie.length !== header.length ||
    !timingSafeEqual(Buffer.from(cookie), Buffer.from(header))
  )
    return next(
      new AppError(403, 'CSRF', 'Your security token expired. Refresh the page and try again.'),
    );
  next();
};
// An account created by an Admin starts with a temporary password. Until the person
// replaces it, these are the only authenticated routes they may call.
const passwordChangeRoutes = ['/api/v1/auth/change-password', '/api/v1/auth/me'];
export const authenticate =
  (db: Database): RequestHandler =>
  async (req, _res, next) => {
    try {
      const token = req.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
      if (!token) throw new Error();
      const { payload } = await jwtVerify(token, key, {
        issuer: 'sdp-inventory',
        audience: 'sdp-web',
        algorithms: ['HS256'],
      });
      const [user] = await db.query<
        User & { token_version: number; must_change_password: boolean }
      >(
        'SELECT id,email,name,role,enabled,token_version,must_change_password FROM users WHERE id=$1 AND enabled=true',
        [payload.sub],
      );
      if (!user || user.token_version !== payload.version) throw new Error();
      const [session] = await db.query(
        'SELECT id FROM sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now()',
        [payload.sid, user.id],
      );
      if (!session) throw new Error();
      req.user = {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        enabled: user.enabled,
      };
      req.sessionId = session.id;
      if (
        user.must_change_password &&
        !passwordChangeRoutes.includes(req.originalUrl.split('?')[0])
      )
        return next(
          new AppError(
            403,
            'PASSWORD_CHANGE_REQUIRED',
            'Choose your own password to continue.',
          ),
        );
      next();
    } catch {
      next(new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.'));
    }
  };
export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role))
      return next(new AppError(403, 'FORBIDDEN', 'Your role cannot perform this action.'));
    next();
  };