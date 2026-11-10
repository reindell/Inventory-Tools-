import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowRight, LockKeyhole, ShieldCheck } from 'lucide-react';
import { useAuth, useBrand } from '../context';
import { api, jsonBody } from '../api';
import { Brand } from '../components/Brand';
import { Button, ErrorBanner, Field, SecretField } from '../components/ui';
import { COMPANY_NAME, loginSchema, passwordSchema } from '../../shared/contracts';

export function AuthPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { login, user } = useAuth();
  const { data: brand } = useBrand();
  const mode =
    location.pathname === '/forgot-password'
      ? 'forgot'
      : location.pathname === '/reset-password'
        ? 'reset'
        : location.pathname === '/activate'
          ? 'activate'
          : 'login';
  const schema =
    mode === 'login'
      ? loginSchema
      : mode === 'forgot'
        ? z.object({ email: z.string().trim().email('Enter a valid email address.') })
        : z.object({
            ...(mode === 'activate'
              ? { name: z.string().trim().min(2, 'Enter your full name.') }
              : {}),
            password: passwordSchema,
          });
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    reset,
  } = useForm<any>({ resolver: zodResolver(schema) });
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [linkToken] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get('token') || '',
  );
  const title =
    mode === 'login'
      ? 'Welcome back'
      : mode === 'forgot'
        ? 'Reset your password'
        : mode === 'activate'
          ? 'Activate your account'
          : 'Choose a new password';
  useEffect(() => {
    document.title = `SDP Inventory | ${mode === 'login' ? 'Sign in' : title}`;
    if (location.hash) window.history.replaceState(null, '', location.pathname);
  }, [mode, title, location.hash, location.pathname]);
  if (user && mode === 'login') return <Navigate to="/" replace />;
  const submit = handleSubmit(async (values) => {
    setError('');
    setMessage('');
    try {
      if (mode === 'login') {
        await login(values.email, values.password);
        navigate('/', { replace: true });
      } else if (mode === 'forgot') {
        const result = await api<{ message: string }>('/auth/forgot-password', {
          method: 'POST',
          body: jsonBody(values),
        });
        setMessage(result.message);
      } else {
        const result = await api<{ message: string }>(
          mode === 'activate' ? '/auth/accept-invitation' : '/auth/reset-password',
          { method: 'POST', body: jsonBody({ ...values, token: linkToken }) },
        );
        setMessage(result.message);
        reset();
      }
    } catch (err) {
      setError((err as Error).message);
    }
  });
  return (
    <div className="auth-page">
      <div className="auth-aside">
        <Link to="/login" aria-label="SDP sign in">
          <Brand theme="dark" />
        </Link>
        <div>
          <p className="eyebrow">PRODUCTION INVENTORY</p>
          <h2>
            Every part.
            <br />
            One clear picture.
          </h2>
          <p>
            Keep stock accurate, follow every movement, and give your production team the confidence
            to keep moving.
          </p>
          <div className="auth-production">
            <span className="status-dot" />
            <span>{brand?.locationName || 'Production'} · Single location</span>
          </div>
        </div>
        <p className="auth-company">{brand?.companyName || COMPANY_NAME}</p>
      </div>
      <main className="auth-main">
        <section className="auth-card">
          <div className="auth-brand">
            <Brand />
          </div>
          <p className="auth-company-name">{brand?.companyName || COMPANY_NAME}</p>
          <h1>{title}</h1>
          <p className="muted">
            {mode === 'login'
              ? 'Sign in to your production workspace.'
              : mode === 'forgot'
                ? 'We’ll send a secure link to your account email.'
                : 'Use at least 12 characters for your password.'}
          </p>
          {error && <ErrorBanner message={error} />}
          {message && (
            <div className="success-banner" role="status">
              <ShieldCheck size={18} />
              {message}
            </div>
          )}
          {(!message || mode === 'forgot') && (
            <form noValidate onSubmit={submit} className="form-stack">
              {mode === 'activate' && (
                <Field
                  label="Full name"
                  autoComplete="name"
                  {...register('name')}
                  error={errors.name?.message as string}
                />
              )}
              {['login', 'forgot'].includes(mode) && (
                <Field
                  label="Email address"
                  type="email"
                  autoComplete="username"
                  placeholder="you@company.com"
                  {...register('email')}
                  error={errors.email?.message as string}
                />
              )}
              {mode !== 'forgot' && (
                <SecretField
                  label="Password"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  {...register('password')}
                  error={errors.password?.message as string}
                />
              )}
              {mode === 'login' && (
                <Link className="forgot-link" to="/forgot-password">
                  Forgot password?
                </Link>
              )}
              <Button intent="primary" type="submit" busy={isSubmitting} className="full-width">
                {mode === 'login'
                  ? 'Sign in'
                  : mode === 'forgot'
                    ? 'Send reset link'
                    : mode === 'activate'
                      ? 'Activate account'
                      : 'Change password'}
                <ArrowRight size={17} />
              </Button>
            </form>
          )}
          {mode !== 'login' && (
            <Link className="back-login" to="/login">
              Back to sign in
            </Link>
          )}
          <div className="auth-security">
            <LockKeyhole size={14} />
            <span>Secure access · Accounts managed by your Admin</span>
          </div>
        </section>
      </main>
    </div>
  );
}
