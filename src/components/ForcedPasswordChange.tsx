import { useState, type FormEvent } from 'react';
import { api, ApiError, jsonBody, refreshSession } from '../api';
import { passwordSchema } from '../../shared/contracts';
import { Button, Dialog, ErrorBanner, SecretField } from './ui';

/**
 * Shown instead of the app when an Admin created the account and the person has not yet
 * replaced the temporary password. The server enforces the same rule on every route
 * (PASSWORD_CHANGE_REQUIRED), so this screen is the only way forward.
 */
export function ForcedPasswordChange({
  onSignOut,
  onDone,
}: {
  onSignOut(): void;
  onDone(): void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problems: Record<string, string> = {};
    if (!current) problems.current = 'Enter the temporary password you were given.';
    const parsed = passwordSchema.safeParse(next);
    if (!parsed.success)
      problems.next = parsed.error.issues[0]?.message || 'Choose a stronger password.';
    else if (next === current) problems.next = 'Choose a password different from the temporary one.';
    if (confirm !== next) problems.confirm = 'The two passwords do not match.';
    setErrors(problems);
    setError('');
    if (Object.keys(problems).length) return;
    setSaving(true);
    const send = () =>
      api('/auth/change-password', {
        method: 'POST',
        body: jsonBody({ currentPassword: current, newPassword: next }),
      });
    try {
      try {
        await send();
      } catch (caught) {
        // The sign-in token lasts 10 minutes; renew it once if it ran out while the form was open.
        if (caught instanceof ApiError && caught.status === 401) {
          await refreshSession();
          await send();
        } else throw caught;
      }
      setDone(true);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'WRONG_PASSWORD')
        setErrors({ current: caught.message });
      else
        setError(
          caught instanceof ApiError
            ? caught.message
            : 'Could not change the password. Try again.',
        );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      title={done ? 'Password changed' : 'Choose your own password'}
      description={
        done
          ? undefined
          : 'Your administrator gave you a temporary password. Replace it with one only you know to continue.'
      }
      onClose={() => {}}
      busy /* keeps this dialog from being dismissed with Esc, the backdrop or the close button */
    >
      {done ? (
        <div style={{ display: 'grid', gap: 16 }}>
          <p>Your password was changed. Sign in again with your new password.</p>
          <div className="dialog-actions">
            <Button intent="primary" emphasis="solid" onClick={onDone}>
              Go to sign in
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="form-stack">
          {error && <ErrorBanner message={error} />}
          <SecretField
            label="Temporary password"
            required
            autoComplete="current-password"
            value={current}
            error={errors.current}
            onChange={(event) => setCurrent(event.target.value)}
          />
          <SecretField
            label="New password"
            required
            autoComplete="new-password"
            value={next}
            error={errors.next}
            onChange={(event) => setNext(event.target.value)}
          />
          <SecretField
            label="Confirm new password"
            required
            autoComplete="new-password"
            value={confirm}
            error={errors.confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
          <div className="dialog-actions">
            <Button disabled={saving} onClick={onSignOut}>
              Sign out
            </Button>
            <Button type="submit" intent="primary" emphasis="solid" busy={saving}>
              Change password
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}