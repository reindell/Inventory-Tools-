import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleSlash,
  Loader2,
  Package,
  Search as SearchIcon,
  X,
} from 'lucide-react';
import { stockState, type Item } from '../../shared/contracts';

export function Button({
  children,
  intent = 'neutral',
  emphasis,
  busy,
  className = '',
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  intent?: 'primary' | 'neutral' | 'danger';
  emphasis?: 'solid' | 'outline' | 'ghost';
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`button ${intent} ${emphasis || (intent === 'primary' ? 'solid' : 'outline')} ${className}`}
    >
      <span className={busy ? 'button-content pending' : 'button-content'}>{children}</span>
      {busy && <Loader2 size={18} className="button-loader spin" aria-hidden="true" />}
    </button>
  );
}
export const Field = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; help?: string }
>(function Field({ label, error, help, id: provided, className = '', ...props }, ref) {
  const generated = useId();
  const id = provided || generated;
  return (
    <div className={`field ${className}`}>
      <label htmlFor={id}>
        {label}
        {props.required && <span aria-hidden="true"> *</span>}
      </label>
      <input
        {...props}
        id={id}
        ref={ref}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : help ? `${id}-help` : undefined}
      />
      {help && <small id={`${id}-help`}>{help}</small>}
      {error && (
        <small className="field-error" id={`${id}-error`}>
          {error}
        </small>
      )}
    </div>
  );
});
export function Select({
  label,
  children,
  id: provided,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string }) {
  const generated = useId();
  const id = provided || generated;
  return (
    <div className="field select-field">
      <label htmlFor={id}>{label}</label>
      <select {...props} id={id}>
        {children}
      </select>
    </div>
  );
}
export function SecretField({
  label = 'Password',
  ...props
}: Omit<React.ComponentProps<typeof Field>, 'type'>) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="secret-field">
      <Field {...props} label={label} type={visible ? 'text' : 'password'} />
      <button
        className="secret-toggle"
        type="button"
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        onClick={() => setVisible(!visible)}
      >
        {visible ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
export function Search({
  value,
  onCommit,
  label = 'Search inventory',
  placeholder = 'Search name, SKU or scan a barcode…',
}: {
  value: string;
  onCommit(value: string): void;
  label?: string;
  placeholder?: string;
}) {
  const [text, setText] = useState(value);
  const [composing, setComposing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const callback = useRef(onCommit);
  callback.current = onCommit;
  useEffect(() => setText(value), [value]);
  useEffect(() => {
    if (composing || text === value) return;
    const timer = setTimeout(() => callback.current(text), 300);
    return () => clearTimeout(timer);
  }, [text, composing, value]);
  return (
    <div className="search-field">
      <SearchIcon size={18} aria-hidden="true" />
      <input
        ref={input}
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            callback.current(text);
          }
        }}
      />
      {text && (
        <button
          type="button"
          className="icon-button"
          aria-label={`Clear ${label.toLowerCase()}`}
          onClick={() => {
            setText('');
            callback.current('');
            input.current?.focus();
          }}
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}
export function StatusBadge({ item }: { item: Pick<Item, 'quantity' | 'reorder_level'> }) {
  const status = stockState(item);
  const Icon = status === 'in' ? CheckCircle2 : status === 'low' ? AlertCircle : CircleSlash;
  return (
    <span className={`badge ${status}`}>
      <Icon size={13} aria-hidden="true" />
      {status === 'in' ? 'In stock' : status === 'low' ? 'Low stock' : 'Out of stock'}
    </span>
  );
}
export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
  className = '',
  busy = false,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose(): void;
  children: ReactNode;
  className?: string;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const callback = useRef(onClose);
  callback.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className={`dialog ${className}`}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) callback.current();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) callback.current();
      }}
    >
      <div className="dialog-inner">
        <div className="dialog-heading">
          <h2 id={titleId}>{title}</h2>
          <Button emphasis="ghost" disabled={busy} aria-label="Close dialog" onClick={onClose}>
            <X size={20} />
          </Button>
        </div>
        {description && (
          <p id={descriptionId} className="muted">
            {description}
          </p>
        )}
        {children}
      </div>
    </dialog>
  );
}
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onClose,
  busy,
  error,
  danger = true,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm(): void;
  onClose(): void;
  busy?: boolean;
  error?: string;
  danger?: boolean;
}) {
  return (
    <Dialog open={open} title={title} description={description} onClose={onClose} busy={busy}>
      {error && <ErrorBanner message={error} />}
      <div className="dialog-actions">
        <Button autoFocus disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          intent={danger ? 'danger' : 'primary'}
          emphasis="solid"
          busy={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
export function ErrorBanner({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <AlertCircle size={18} aria-hidden="true" />
      <div>
        <p>{message}</p>
        {retry && (
          <button type="button" className="text-button" onClick={retry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}
export function EmptyState({
  title = 'No items found',
  description = 'Try a different search or clear your filters.',
  action,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <Package size={32} aria-hidden="true" />
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" className="skeleton-group" role="status">
      <span className="sr-only">Loading records…</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton-row">
          <span className="skeleton square" />
          <span className="skeleton line" />
          <span className="skeleton short" />
        </div>
      ))}
    </div>
  );
}
export function Pagination({
  total,
  page,
  pageSize,
  onChange,
}: {
  total: number;
  page: number;
  pageSize: number;
  onChange(value: number): void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  useEffect(() => {
    if (page > pages) onChange(pages);
  }, [page, pages, onChange]);
  return (
    <nav className="pagination" aria-label="Pagination">
      <span>
        {total
          ? `${((page - 1) * pageSize + 1).toLocaleString()}–${Math.min(page * pageSize, total).toLocaleString()} of ${total.toLocaleString()}`
          : '0 records'}
      </span>
      <div>
        <Button disabled={page <= 1} aria-label="Previous page" onClick={() => onChange(page - 1)}>
          <ChevronLeft size={16} />
        </Button>
        <span aria-current="page">
          Page {Math.min(page, pages)} of {pages}
        </span>
        <Button disabled={page >= pages} aria-label="Next page" onClick={() => onChange(page + 1)}>
          <ChevronRight size={16} />
        </Button>
      </div>
    </nav>
  );
}
const ToastContext = createContext<
  (message: string, intent?: 'success' | 'error' | 'info') => void
>(() => {});
export const useToast = () => useContext(ToastContext);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; intent: string; id: number } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);
  return (
    <ToastContext.Provider
      value={(message, intent = 'success') => setToast({ message, intent, id: Date.now() })}
    >
      {children}
      <div className="toast-region" role="status" aria-live="polite" aria-atomic="true">
        {toast && (
          <div className={`toast ${toast.intent}`}>
            <Check size={18} aria-hidden="true" />
            <span>{toast.message}</span>
            <button
              className="icon-button"
              type="button"
              aria-label="Dismiss notification"
              onClick={() => setToast(null)}
            >
              <X size={16} />
            </button>
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}
