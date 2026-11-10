import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import type { Database } from './db.js';
import { audit } from './db.js';
import { AppError } from './errors.js';
import {
  accessToken,
  authenticate,
  cookieOptions,
  hashToken,
  newSession,
  secretToken,
} from './security.js';
import { loginSchema, passwordSchema } from '../shared/contracts.js';
import { config } from './config.js';

export function authRoutes(db: Database) {
  const router = Router();
  const loginLimit = rateLimit({
    windowMs: 15 * 60000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: {
      error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in 15 minutes.' },
    },
  });
  router.get('/csrf', (req, res) => {
    const token =
      typeof req.signedCookies.sdp_csrf === 'string' ? req.signedCookies.sdp_csrf : secretToken();
    res.cookie('sdp_csrf', token, {
      signed: true,
      httpOnly: true,
      secure: config.production,
      sameSite: 'strict',
      path: '/api',
      maxAge: 86400000,
    });
    res.json({ token });
  });
  router.post('/login', loginLimit, async (req, res) => {
    const data = loginSchema.parse(req.body);
    const outcome = await db.transaction(async (tx) => {
      const [user] = await tx.query('SELECT * FROM users WHERE email=$1 FOR UPDATE', [
        data.email.toLowerCase(),
      ]);
      // Always spend bcrypt time for unknown accounts to reduce identity timing leakage.
      const valid = await bcrypt.compare(
        data.password,
        user?.password_hash || '$2b$12$P5h/8K2Kc14Ou/fbAJFY4uQoq.xa2Fi6mFt6uJ0KeqjJEUyVq4Bbi',
      );
      if (
        !user ||
        !user.enabled ||
        (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) ||
        !valid
      ) {
        if (user)
          await tx.query(
            "UPDATE users SET failed_logins=failed_logins+1,locked_until=CASE WHEN failed_logins+1>=5 THEN now()+interval '15 minutes' ELSE locked_until END WHERE id=$1",
            [user.id],
          );
        await audit(
          tx,
          user?.id || null,
          'login.failed',
          'user',
          user?.id || null,
          null,
          null,
          req.requestId,
        );
        return null;
      }
      await tx.query('UPDATE users SET failed_logins=0,locked_until=NULL WHERE id=$1', [user.id]);
      const sessionId = await newSession(tx, user.id, randomUUID(), res);
      await audit(tx, user.id, 'login.succeeded', 'user', user.id, null, null, req.requestId);
      return { user, sessionId };
    });
    if (!outcome)
      throw new AppError(
        401,
        'LOGIN_FAILED',
        'Email or password is incorrect, or access is temporarily locked. Try again later.',
      );
    res.json({
      token: await accessToken(outcome.user, outcome.sessionId),
      user: publicUser(outcome.user),
    });
  });
  router.post('/refresh', async (req, res) => {
    const raw = req.cookies.sdp_refresh;
    if (typeof raw !== 'string') throw new AppError(401, 'SESSION_EXPIRED', 'Sign in to continue.');
    const result = await db.transaction(async (tx) => {
      const [session] = await tx.query('SELECT * FROM sessions WHERE token_hash=$1 FOR UPDATE', [
        hashToken(raw),
      ]);
      if (!session) return null;
      if (session.rotated_at) {
        await tx.query('UPDATE sessions SET revoked_at=now() WHERE family_id=$1', [
          session.family_id,
        ]);
        await audit(
          tx,
          session.user_id,
          'session.reuse_detected',
          'session',
          session.id,
          null,
          null,
          req.requestId,
        );
        return null;
      }
      if (session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) return null;
      const [user] = await tx.query('SELECT * FROM users WHERE id=$1 AND enabled=true', [
        session.user_id,
      ]);
      if (!user) return null;
      await tx.query('UPDATE sessions SET rotated_at=now() WHERE id=$1', [session.id]);
      return { user, sessionId: await newSession(tx, user.id, session.family_id, res) };
    });
    if (!result) {
      res.clearCookie('sdp_refresh', cookieOptions);
      throw new AppError(401, 'SESSION_EXPIRED', 'Sign in to continue.');
    }
    res.json({
      token: await accessToken(result.user, result.sessionId),
      user: publicUser(result.user),
    });
  });
  router.post('/logout', async (req, res) => {
    if (typeof req.cookies.sdp_refresh === 'string')
      await db.transaction(async (tx) => {
        const [session] = await tx.query('SELECT * FROM sessions WHERE token_hash=$1', [
          hashToken(req.cookies.sdp_refresh),
        ]);
        if (session) {
          await tx.query('UPDATE sessions SET revoked_at=now() WHERE family_id=$1', [
            session.family_id,
          ]);
          await audit(
            tx,
            session.user_id,
            'logout',
            'session',
            session.id,
            null,
            null,
            req.requestId,
          );
        }
      });
    res.clearCookie('sdp_refresh', cookieOptions).status(204).end();
  });
  router.get('/me', authenticate(db), (req, res) => res.json(req.user));
  router.post('/forgot-password', loginLimit, async (req, res) => {
    const { email } = z
      .object({ email: z.string().trim().email().max(254) })
      .strict()
      .parse(req.body);
    await db.transaction(async (tx) => {
      const [user] = await tx.query('SELECT id,email FROM users WHERE email=$1 AND enabled=true', [
        email.toLowerCase(),
      ]);
      if (!user) return;
      const token = secretToken();
      await tx.query(
        'UPDATE reset_tokens SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL',
        [user.id],
      );
      await tx.query(
        "INSERT INTO reset_tokens(user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '30 minutes')",
        [user.id, hashToken(token)],
      );
      await tx.query("INSERT INTO outbox(type,payload) VALUES ('password-reset',$1::jsonb)", [
        JSON.stringify({ to: user.email, token }),
      ]);
      await audit(
        tx,
        user.id,
        'password_reset.requested',
        'user',
        user.id,
        null,
        null,
        req.requestId,
      );
    });
    res.json({ message: 'If this account exists, a password reset email will arrive shortly.' });
  });
  router.post('/reset-password', loginLimit, async (req, res) => {
    const data = z
      .object({ token: z.string().min(32).max(128), password: passwordSchema })
      .strict()
      .parse(req.body);
    const hashed = await bcrypt.hash(data.password, 12);
    await db.transaction(async (tx) => {
      const [token] = await tx.query(
        'SELECT * FROM reset_tokens WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE',
        [hashToken(data.token)],
      );
      if (!token)
        throw new AppError(
          422,
          'INVALID_TOKEN',
          'This reset link is invalid or expired. Request another email.',
        );
      await tx.query('UPDATE reset_tokens SET consumed_at=now() WHERE id=$1', [token.id]);
      await tx.query(
        'UPDATE users SET password_hash=$1,must_change_password=false,token_version=token_version+1,failed_logins=0,locked_until=NULL WHERE id=$2',
        [hashed, token.user_id],
      );
      await tx.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [token.user_id]);
      await audit(
        tx,
        token.user_id,
        'password_reset.completed',
        'user',
        token.user_id,
        null,
        null,
        req.requestId,
      );
    });
    res.json({ message: 'Password changed. Sign in with your new password.' });
  });
    router.post('/change-password', loginLimit, authenticate(db), async (req, res) => {
    const data = z
      .object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema })
      .strict()
      .parse(req.body);
    if (data.newPassword === data.currentPassword)
      throw new AppError(
        422,
        'PASSWORD_UNCHANGED',
        'Choose a password different from your current one.',
      );
    const hashed = await bcrypt.hash(data.newPassword, 12);
    await db.transaction(async (tx) => {
      const [user] = await tx.query('SELECT id,password_hash FROM users WHERE id=$1 FOR UPDATE', [
        req.user!.id,
      ]);
      if (!user || !(await bcrypt.compare(data.currentPassword, user.password_hash)))
        throw new AppError(422, 'WRONG_PASSWORD', 'Your current password is incorrect.');
      await tx.query(
        'UPDATE users SET password_hash=$1,must_change_password=false,token_version=token_version+1 WHERE id=$2',
        [hashed, user.id],
      );
      // Every session ends, so the person signs in again with the new password.
      await tx.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [user.id]);
      await audit(tx, user.id, 'password.changed', 'user', user.id, null, null, req.requestId);
    });
    res.clearCookie('sdp_refresh', cookieOptions);
    res.json({ message: 'Password changed. Sign in with your new password.' });
  });
  router.post('/accept-invitation', loginLimit, async (req, res) => {
    const data = z
      .object({
        token: z.string().min(32).max(128),
        name: z.string().trim().min(2).max(100),
        password: passwordSchema,
      })
      .strict()
      .parse(req.body);
    const hashed = await bcrypt.hash(data.password, 12);
    await db.transaction(async (tx) => {
      const [invitation] = await tx.query(
        'SELECT * FROM invitations WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE',
        [hashToken(data.token)],
      );
      if (!invitation)
        throw new AppError(
          422,
          'INVALID_TOKEN',
          'This invitation is invalid or expired. Ask an Admin for a new invitation.',
        );
      const [user] = await tx.query(
        'INSERT INTO users(email,name,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING id',
        [invitation.email, data.name, hashed, invitation.role],
      );
      await tx.query('UPDATE invitations SET consumed_at=now() WHERE id=$1', [invitation.id]);
      await audit(
        tx,
        user.id,
        'invitation.accepted',
        'user',
        user.id,
        null,
        { role: invitation.role },
        req.requestId,
      );
    });
    res.status(201).json({ message: 'Your account is ready. Sign in to continue.' });
  });
  return router;
}
function publicUser(user: any) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    enabled: user.enabled,
    mustChangePassword: !!user.must_change_password,
  };
}
