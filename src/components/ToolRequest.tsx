import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Package, Send } from 'lucide-react';
import type { Item } from '../../shared/contracts';
import { toolRequestSchema, type RequestStatus, type ToolRequest } from '../../shared/requests';
import { api, jsonBody } from '../api';
import { useFormat } from '../context';
import { Button, Dialog, ErrorBanner, Field, useToast } from './ui';

export function ToolPhoto({ src, name }: { src: string | null; name: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className="tool-photo">
      {src && failed !== src ? (
        <img
          src={src}
          alt=""
          width={64}
          height={64}
          loading="lazy"
          onError={() => setFailed(src)}
        />
      ) : (
        <Package size={26} aria-label={`No photo for ${name}`} />
      )}
    </span>
  );
}

export function RequestStatusBadge({ status }: { status: RequestStatus }) {
  const labels: Record<RequestStatus, string> = {
    pending: 'Pending review',
    approved: 'Approved',
    rejected: 'Rejected',
    cancelled: 'Cancelled',
    issued: 'In use',
    returned: 'Returned',
  };
  return <span className={`request-status request-status-${status}`}>{labels[status]}</span>;
}

export function ToolRequestDialog({ item, onClose }: { item: Item | null; onClose(): void }) {
  const [quantity, setQuantity] = useState('1');
  const [purpose, setPurpose] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const quantityRef = useRef<HTMLInputElement>(null);
  const purposeRef = useRef<HTMLTextAreaElement>(null);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const client = useQueryClient();
  const toast = useToast();
  const format = useFormat();
  useEffect(() => {
    setQuantity('1');
    setPurpose('');
    setErrors({});
    setError('');
    attempt.current = null;
  }, [item?.id]);
  const mutation = useMutation({
    mutationFn: async (data: { itemId: string; quantity: number; purpose: string }) => {
      const signature = JSON.stringify(data);
      if (attempt.current?.signature !== signature)
        attempt.current = { signature, key: crypto.randomUUID() };
      return api<ToolRequest>('/requests', {
        method: 'POST',
        headers: { 'Idempotency-Key': attempt.current.key },
        body: jsonBody(data),
      });
    },
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['requests'] }),
        client.invalidateQueries({ queryKey: ['request-summary'] }),
        client.invalidateQueries({ queryKey: ['notifications'] }),
      ]);
      toast('Tool request sent. An Admin will review it.');
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    const result = toolRequestSchema.safeParse({ itemId: item?.id, quantity, purpose });
    if (!result.success) {
      const next: Record<string, string> = {};
      for (const issue of result.error.issues) next[String(issue.path[0])] ||= issue.message;
      setErrors(next);
      if (next.quantity) quantityRef.current?.focus();
      else purposeRef.current?.focus();
      return;
    }
    if (item && result.data.quantity > item.quantity) {
      setErrors({
        quantity: `Only ${format.number(item.quantity)} units are currently available.`,
      });
      quantityRef.current?.focus();
      return;
    }
    setErrors({});
    mutation.mutate(result.data);
  };
  return (
    <Dialog
      open={!!item}
      title="Request tools or jigs"
      description="Choose a quantity and tell the Admin what you need it for."
      onClose={onClose}
      busy={mutation.isPending}
    >
      {item && (
        <form noValidate onSubmit={submit} className="form-stack">
          <div className="request-item-preview">
            <ToolPhoto src={item.image_url} name={item.name} />
            <div>
              <strong>{item.name}</strong>
              <span className="sku">{item.sku}</span>
              <small>{format.number(item.quantity)} units available</small>
            </div>
          </div>
          {error && <ErrorBanner message={error} />}
          <Field
            ref={quantityRef}
            autoFocus
            label="Quantity requested"
            type="number"
            inputMode="numeric"
            min={1}
            max={item.quantity}
            step={1}
            required
            value={quantity}
            disabled={mutation.isPending}
            onChange={(event) => setQuantity(event.target.value)}
            error={errors.quantity}
          />
          <div className="field">
            <label htmlFor="request-purpose">
              Purpose <span aria-hidden="true">*</span>
            </label>
            <textarea
              id="request-purpose"
              className="resize-none"
              ref={purposeRef}
              rows={3}
              maxLength={1000}
              required
              value={purpose}
              disabled={mutation.isPending}
              onChange={(event) => setPurpose(event.target.value)}
              aria-invalid={!!errors.purpose}
              aria-describedby={errors.purpose ? 'request-purpose-error' : 'request-purpose-help'}
            />
            <small id="request-purpose-help">For example, the production task or work area.</small>
            {errors.purpose && (
              <small id="request-purpose-error" className="field-error">
                {errors.purpose}
              </small>
            )}
          </div>
          <p className="muted request-note">
            Sending a request does not reserve or deduct stock. You can cancel it until the Admin
            issues the tools.
          </p>
          <div className="dialog-actions">
            <Button disabled={mutation.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" intent="primary" busy={mutation.isPending}>
              <Send size={16} />
              Send request
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
