import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowDownLeft, ArrowUpRight, SlidersHorizontal } from 'lucide-react';
import { stockSchema, type Item, type ItemDetail, type StockInput } from '../../shared/contracts';
import { api, ApiError, jsonBody } from '../api';
import { useAuth } from '../context';
import { Button, Dialog, ErrorBanner, Field, Select, useToast } from './ui';

export function StockDialog({ item, onClose }: { item: Item | null; onClose(): void }) {
  const { user } = useAuth();
  const client = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState('');
  const [current, setCurrent] = useState(item);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const form = useForm<StockInput>({ resolver: zodResolver(stockSchema) as Resolver<StockInput> });
  const {
    register,
    reset,
    watch,
    setValue,
    handleSubmit,
    formState: { errors },
  } = form;
  useEffect(() => {
    setCurrent(item);
    setError('');
    attempt.current = null;
    if (item)
      reset({
        itemId: item.id,
        type: 'in',
        quantity: 1,
        reason: '',
        note: '',
        expectedVersion: item.stock_version,
        direction: 'add',
        serials: [],
        outStatus: 'sold',
      });
  }, [item, reset]);
  const type = watch('type');
  const quantity = Number(watch('quantity') || 0);
  const removing = type === 'out' || (type === 'adjustment' && watch('direction') === 'remove');
  const mutation = useMutation({
    mutationFn: async (data: StockInput) => {
      const signature = JSON.stringify(data);
      if (attempt.current?.signature !== signature)
        attempt.current = { signature, key: crypto.randomUUID() };
      return api('/stock', {
        method: 'POST',
        headers: { 'Idempotency-Key': attempt.current.key },
        body: jsonBody(data),
      });
    },
    onSuccess: async () => {
      await client.invalidateQueries();
      toast('Stock movement recorded.');
      onClose();
    },
    onError: async (err: Error) => {
      setError(err.message);
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT' && item) {
        try {
          const result = await api<ItemDetail>(`/items/${item.id}`);
          setCurrent(result.item);
          setValue('expectedVersion', result.item.stock_version);
          attempt.current = null;
        } catch {
          /* The original error remains actionable. */
        }
      }
    },
  });
  return (
    <Dialog
      open={!!item}
      title="Manage stock"
      description={current ? `${current.name} · ${current.sku}` : undefined}
      onClose={onClose}
      busy={mutation.isPending}
    >
      <form
        noValidate
        onSubmit={handleSubmit((values) => {
          setError('');
          mutation.mutate(values);
        })}
        className="form-stack"
      >
        <div className="stock-operation-tabs" role="group" aria-label="Stock operation">
          {[
            { value: 'in', label: 'Stock in', icon: ArrowDownLeft },
            { value: 'out', label: 'Stock out', icon: ArrowUpRight },
            ...(['Admin', 'Manager'].includes(user!.role)
              ? [{ value: 'adjustment', label: 'Adjustment', icon: SlidersHorizontal }]
              : []),
          ].map(({ value, label, icon: Icon }) => (
            <button
              type="button"
              key={value}
              aria-pressed={type === value}
              className={type === value ? 'selected' : ''}
              onClick={() => setValue('type', value as StockInput['type'])}
            >
              <Icon size={17} />
              {label}
            </button>
          ))}
        </div>
        <div className="stock-preview">
          <div>
            <small>Current stock</small>
            <strong>{current?.quantity.toLocaleString() || 0}</strong>
          </div>
          <span aria-hidden="true">→</span>
          <div>
            <small>After movement</small>
            <strong
              className={
                (current?.quantity || 0) + (removing ? -quantity : quantity) < 0 ? 'negative' : ''
              }
            >
              {((current?.quantity || 0) + (removing ? -quantity : quantity)).toLocaleString()}
            </strong>
          </div>
        </div>
        {error && <ErrorBanner message={error} />}
        <div className="form-grid">
          <Field
            label="Quantity"
            type="number"
            min={1}
            max={1000000000}
            {...register('quantity', { valueAsNumber: true })}
            error={errors.quantity?.message}
          />
          {type === 'adjustment' && (
            <Select label="Adjustment direction" {...register('direction')}>
              <option value="add">Add units</option>
              <option value="remove">Remove units</option>
            </Select>
          )}
          {current?.serialized && removing && (
            <Select label="Unit disposition" {...register('outStatus')}>
              <option value="sold">Issued / sold</option>
              <option value="damaged">Damaged</option>
            </Select>
          )}
        </div>
        <Field
          label="Reason"
          placeholder={
            type === 'in' ? 'e.g. Supplier delivery received' : 'e.g. Issued to production'
          }
          {...register('reason')}
          error={errors.reason?.message}
        />
        {current?.serialized && (
          <div className="field">
            <label htmlFor="stock-serials">Serial numbers · one per line</label>
            <textarea
              id="stock-serials"
              className="resize-none"
              style={{ resize: 'none' }}
              rows={4}
              aria-invalid={!!errors.serials}
              aria-describedby={errors.serials ? 'stock-serial-error' : undefined}
              onChange={(event) =>
                setValue(
                  'serials',
                  event.target.value
                    .split(/[\n,]/)
                    .map((v) => v.trim())
                    .filter(Boolean),
                )
              }
            />
            {errors.serials && (
              <small className="field-error" id="stock-serial-error">
                {errors.serials.message || 'Check the serial numbers.'}
              </small>
            )}
          </div>
        )}
        <div className="field">
          <label htmlFor="stock-note">
            Note <span className="muted">(optional)</span>
          </label>
          <textarea
            id="stock-note"
            className="resize-none"
            style={{ resize: 'none' }}
            rows={3}
            {...register('note')}
          />
        </div>
        <div className="dialog-actions">
          <Button disabled={mutation.isPending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" intent="primary" busy={mutation.isPending}>
            Record{' '}
            {type === 'adjustment' ? 'adjustment' : type === 'out' ? 'stock out' : 'stock in'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
