import { useEffect, useRef, useState } from 'react';
import { Link, useBlocker, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, Save } from 'lucide-react';
import { itemSchema, type Item, type ItemDetail, type ItemInput } from '../../shared/contracts';
import { api, ApiError, jsonBody } from '../api';
import { useAuth } from '../context';
import { Page } from '../components/Page';
import { Button, ConfirmDialog, ErrorBanner, Field, Skeleton, useToast } from '../components/ui';

const defaults: ItemInput = {
  name: '',
  sku: '',
  barcode: '',
  category: '',
  description: '',
  supplier: '',
  reorderLevel: 10,
  serialized: false,
};
const draftFields = [
  'name',
  'sku',
  'barcode',
  'category',
  'description',
  'supplier',
  'reorderLevel',
  'serialized',
  'version',
] as const satisfies readonly (keyof ItemInput)[];
function itemValues(values: unknown): ItemInput {
  const source = values && typeof values === 'object' ? (values as Record<string, unknown>) : {};
  return {
    ...defaults,
    ...Object.fromEntries(
      draftFields
        .filter((field) => Object.hasOwn(source, field))
        .map((field) => [field, source[field]]),
    ),
  } as ItemInput;
}
export function ItemEditorPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const toast = useToast();
  const returnTo = (location.state as { returnTo?: string })?.returnTo || '/inventory';
  const key = `sdp-item-draft:${user!.id}:${id || 'new'}`;
  const [error, setError] = useState('');
  const [discard, setDiscard] = useState(false);
  const [draft, setDraft] = useState<ItemInput | null>(null);
  const [draftSaved, setDraftSaved] = useState(false);
  const initialized = useRef(false);
  const query = useQuery({
    queryKey: ['item', id],
    queryFn: ({ signal }) => api<ItemDetail>(`/items/${id}`, { signal }),
    enabled: !!id,
  });
  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => api<string[]>('/categories'),
  });
  const suppliers = useQuery({
    queryKey: ['suppliers'],
    queryFn: () => api<string[]>('/suppliers'),
  });
  const {
    register,
    handleSubmit,
    reset,
    watch,
    setError: fieldError,
    clearErrors,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<ItemInput>({
    resolver: zodResolver(itemSchema) as Resolver<ItemInput>,
    defaultValues: defaults,
  });
  const allowNavigation = useRef(false);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      isDirty && !allowNavigation.current && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (initialized.current || (id && !query.data)) return;
    initialized.current = true;
    if (query.data) {
      const i = query.data.item;
      reset({
        name: i.name,
        sku: i.sku,
        barcode: i.barcode || '',
        category: i.category,
        supplier: i.supplier,
        description: i.description,
        reorderLevel: i.reorder_level,
        serialized: i.serialized,
        version: i.version,
      });
    }
    try {
      const saved = sessionStorage.getItem(key);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Date.now() - parsed.savedAt < 86400000) setDraft(itemValues(parsed.values));
      }
    } catch {
      /* Storage may be disabled. */
    }
  }, [id, key, query.data, reset]);
  useEffect(() => {
    const subscription = watch((values) => {
      if (!initialized.current) return;
      try {
        sessionStorage.setItem(
          key,
          JSON.stringify({ savedAt: Date.now(), values: itemValues(values) }),
        );
        setDraftSaved(true);
      } catch {
        /* Draft persistence is optional. */
      }
    });
    return () => subscription.unsubscribe();
  }, [watch, key]);
  useEffect(() => {
    const before = (event: BeforeUnloadEvent) => {
      if (isDirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [isDirty]);
  const sku = watch('sku');
  const barcode = watch('barcode');
  useEffect(() => {
    if (!sku) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const p = new URLSearchParams({
          sku,
          ...(barcode ? { barcode } : {}),
          ...(id ? { excludeId: id } : {}),
        });
        const result = await api<{ skuExists: boolean; barcodeExists: boolean }>(
          `/items/check-identity?${p}`,
          { signal: controller.signal },
        );
        if (result.skuExists)
          fieldError('sku', { type: 'duplicate', message: 'This SKU already exists.' });
        else clearErrors('sku');
        if (result.barcodeExists)
          fieldError('barcode', { type: 'duplicate', message: 'This barcode already exists.' });
        else clearErrors('barcode');
      } catch {
        /* Final save always enforces identity uniqueness. */
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [sku, barcode, id, fieldError, clearErrors]);
  const save = handleSubmit(async (values) => {
    setError('');
    try {
      const item = await api<Item>(id ? `/items/${id}` : '/items', {
        method: id ? 'PATCH' : 'POST',
        body: jsonBody(values),
      });
      reset(values);
      sessionStorage.removeItem(key);
      allowNavigation.current = true;
      await client.invalidateQueries();
      toast(id ? 'Item updated.' : 'Item created. Add photos from the item detail page.');
      navigate(returnTo, { state: { savedItemId: item.id } });
    } catch (err) {
      setError((err as Error).message);
      if (err instanceof ApiError && err.fields)
        Object.entries(err.fields).forEach(([name, messages]) =>
          fieldError(name as keyof ItemInput, { message: messages[0] }),
        );
    }
  });
  if (!['Admin', 'Manager'].includes(user!.role))
    return (
      <Page title="Access restricted">
        <ErrorBanner message="Your role cannot create or edit items." />
      </Page>
    );
  return (
    <Page
      title={id ? 'Edit item' : 'Add item'}
      eyebrow="INVENTORY"
      description="Create a clear record for every production part."
      actions={
        <Button onClick={() => (isDirty ? setDiscard(true) : navigate(returnTo))}>
          <ArrowLeft size={16} />
          Back to inventory
        </Button>
      }
    >
      {id && query.isPending ? (
        <Skeleton rows={6} />
      ) : query.isError ? (
        <ErrorBanner message={query.error.message} retry={() => void query.refetch()} />
      ) : (
        <form noValidate onSubmit={save} className="item-editor">
          <div className="editor-main">
            {error && <ErrorBanner message={error} />}
            {draft && (
              <div className="draft-banner">
                <p>A local draft is available.</p>
                <Button
                  onClick={() => {
                    reset(
                      {
                        ...itemValues(draft),
                        ...(query.data ? { version: query.data.item.version } : {}),
                      },
                      { keepDefaultValues: true },
                    );
                    setDraft(null);
                  }}
                >
                  Restore draft
                </Button>
                <Button
                  emphasis="ghost"
                  onClick={() => {
                    sessionStorage.removeItem(key);
                    setDraft(null);
                  }}
                >
                  Discard draft
                </Button>
              </div>
            )}
            <section className="panel form-panel">
              <div className="section-label">
                <span className="section-icon">A</span>
                <div>
                  <h2>Item identity</h2>
                  <p>The information your team uses to find this part.</p>
                </div>
              </div>
              <Field
                label="Item name"
                required
                placeholder="e.g. Bridge rectifier D25XB80"
                {...register('name')}
                error={errors.name?.message}
              />
              <div className="form-grid">
                <Field
                  label="SKU"
                  required
                  placeholder="e.g. SDP-BR-0025"
                  {...register('sku')}
                  error={errors.sku?.message}
                  help="Unique across all active and archived items."
                />
                <Field
                  label="Barcode"
                  placeholder="Optional scanner code"
                  {...register('barcode')}
                  error={errors.barcode?.message}
                />
              </div>
              <div className="form-grid">
                <Field
                  label="Category"
                  required
                  list="item-categories"
                  placeholder="Choose or enter a category"
                  {...register('category')}
                  error={errors.category?.message}
                />
                <datalist id="item-categories">
                  {categories.data?.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
                <Field
                  label="Supplier"
                  list="item-suppliers"
                  placeholder="Choose or enter a supplier"
                  {...register('supplier')}
                  error={errors.supplier?.message}
                />
                <datalist id="item-suppliers">
                  {suppliers.data?.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </div>
              <div className="field">
                <label htmlFor="item-description">Description</label>
                <textarea
                  id="item-description"
                  className="resize-none"
                  style={{ resize: 'none' }}
                  rows={5}
                  {...register('description')}
                  aria-invalid={!!errors.description}
                  aria-describedby={errors.description ? 'description-error' : undefined}
                />
                {errors.description && (
                  <small className="field-error" id="description-error">
                    {errors.description.message}
                  </small>
                )}
              </div>
            </section>
            <section className="panel form-panel">
              <div className="section-label">
                <span className="section-icon">B</span>
                <div>
                  <h2>Stock rules</h2>
                  <p>Stock quantities are managed through recorded movements.</p>
                </div>
              </div>
              <div className="form-grid">
                <Field
                  label="Reorder level"
                  required
                  type="number"
                  min="0"
                  step="1"
                  {...register('reorderLevel', { valueAsNumber: true })}
                  error={errors.reorderLevel?.message}
                />
              </div>
              <label className="checkbox-label">
                <input type="checkbox" {...register('serialized')} />
                <span>
                  <strong>Track individual serial numbers</strong>
                  <small>
                    Each unit requires a unique serial number. This cannot change after stock
                    history exists.
                  </small>
                </span>
              </label>
            </section>
          </div>
          <aside className="editor-summary panel">
            <h2>Ready to save?</h2>
            <p className="muted">
              New items start with zero stock. Receive units through Manage stock after saving.
            </p>
            <p className="muted">Add up to five photos from the item detail page.</p>
            <Button intent="primary" type="submit" busy={isSubmitting} className="full-width">
              <Save size={17} />
              {id ? 'Save changes' : 'Create item'}
            </Button>
            <Button
              className="full-width"
              onClick={() => (isDirty ? setDiscard(true) : navigate(returnTo))}
            >
              Cancel
            </Button>
            <small className="muted">
              {draftSaved
                ? 'Draft saved on this device for this session.'
                : 'Your changes are not saved yet.'}
            </small>
            {id && (
              <Link to={`/inventory/${id}`} className="text-link">
                View item detail
              </Link>
            )}
          </aside>
        </form>
      )}
      <ConfirmDialog
        open={discard || blocker.state === 'blocked'}
        title="Discard unsaved changes?"
        description="Your changes have not been saved to inventory. The local draft remains available in this session."
        confirmLabel="Discard changes"
        onConfirm={() => {
          allowNavigation.current = true;
          reset();
          if (blocker.state === 'blocked') blocker.proceed();
          else navigate(returnTo);
        }}
        onClose={() => {
          setDiscard(false);
          if (blocker.state === 'blocked') blocker.reset();
        }}
      />
    </Page>
  );
}
