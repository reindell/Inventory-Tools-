import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, jsonBody } from '../api';
import { passwordSchema, roles, type Role } from '../../shared/contracts';
import { Button, Dialog, ErrorBanner, Field, Select, useToast } from './ui';

const roleHelp: Record<string, string> = {
  Admin: 'Requests, issues, returns and full administration.',
  Manager: 'Catalog, photos, stock and their own requests.',
  Staff: 'Browse tools, request quantities and cancel their own requests.',
  Viewer: 'Read inventory and export.',
};

const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%^&*-_=+'];

function randomInt(max: number) {
  const buffer = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / max) * max;
  do crypto.getRandomValues(buffer);
  while (buffer[0] >= limit);
  return buffer[0] % max;
}

// Builds a 16-character password and keeps trying until it passes the same
// passwordSchema the server enforces, so the rules never need to be copied here.
function generatePassword() {
  const all = sets.join('');
  let value = '';
  for (let attempt = 0; attempt < 20; attempt++) {
    const chars = sets.map((set) => set[randomInt(set.length)]);
    while (chars.length < 16) chars.push(all[randomInt(all.length)]);
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    value = chars.join('');
    if (passwordSchema.safeParse(value).success) break;
  }
  return value;
}

export function AddAccountDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose(): void;
  /** Called after an account is created, so the page can refresh its user list. */
  onCreated(): void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('Staff');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ name: string; email: string; password: string } | null>(
    null,
  );

  const reset = () => {
    setName('');
    setEmail('');
    setPassword('');
    setRole('Staff');
    setErrors({});
    setError('');
    setCreated(null);
  };
  useEffect(() => {
    if (open) reset();
  }, [open]);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label} copied.`, 'info');
    } catch {
      toast('Copy failed. Select the text and copy it manually.', 'error');
    }
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (name.trim().length < 2) next.name = "Enter the person's full name.";
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) next.email = 'Enter a valid email address.';
    const parsed = passwordSchema.safeParse(password);
    if (!parsed.success)
      next.password = parsed.error.issues[0]?.message || 'Choose a stronger password.';
    setErrors(next);
    setError('');
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      await api('/users', {
        method: 'POST',
        body: jsonBody({ name: name.trim(), email: email.trim(), password, role }),
      });
      setCreated({ name: name.trim(), email: email.trim().toLowerCase(), password });
      toast(`Account created for ${name.trim()}.`);
      onCreated();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'DUPLICATE')
        setErrors({ email: caught.message });
      else
        setError(
          caught instanceof ApiError ? caught.message : 'Could not create the account. Try again.',
        );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      title={created ? 'Account created' : 'Add account'}
      description={
        created
          ? undefined
          : 'Create a sign-in for someone on the production team. They choose their own password when they first sign in.'
      }
      onClose={onClose}
      busy={busy}
    >
      {created ? (
        <div style={{ display: 'grid', gap: 16 }}>
          <p>
            Share these sign-in details with {created.name}. They will be asked to choose their own
            password the first time they sign in. This temporary password is not shown again once
            you close this window.
          </p>
          <div style={{ display: 'grid', gap: 4 }}>
            <span className="muted">Email</span>
            <strong>{created.email}</strong>
            <span className="muted" style={{ marginTop: 8 }}>
              Temporary password
            </span>
            <code style={{ fontSize: '1.05rem', userSelect: 'all' }}>{created.password}</code>
          </div>
          <div className="dialog-actions">
            <Button
              onClick={() =>
                copy(`Email: ${created.email}\nTemporary password: ${created.password}`, 'Sign-in details')
              }
            >
              Copy details
            </Button>
            <Button onClick={reset}>Add another</Button>
            <Button intent="primary" emphasis="solid" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} noValidate className="form-stack">
          {error && <ErrorBanner message={error} />}
          <Field
            label="Full name"
            required
            autoComplete="off"
            value={name}
            error={errors.name}
            onChange={(event) => setName(event.target.value)}
          />
          <Field
            label="Email"
            type="email"
            required
            autoComplete="off"
            value={email}
            error={errors.email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Select
            label="Role"
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
          >
            {roles.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
          <p className="muted" style={{ margin: 0 }}>
            {roleHelp[role]}
          </p>
          <Field
            label="Temporary password"
            required
            type="text"
            autoComplete="new-password"
            spellCheck={false}
            value={password}
            error={errors.password}
            help="Use Generate for a strong one, then pass it to the person. They replace it at first sign-in."
            onChange={(event) => setPassword(event.target.value)}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button onClick={() => setPassword(generatePassword())}>Generate</Button>
            <Button disabled={!password} onClick={() => copy(password, 'Password')}>
              Copy
            </Button>
          </div>
          <div className="dialog-actions">
            <Button disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" intent="primary" emphasis="solid" busy={busy}>
              Create account
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}