import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDownLeft, ClipboardList, Package, X } from 'lucide-react';
import type { Page as PageData } from '../../shared/contracts';
import {
  requestStatuses,
  requestActionSchema,
  requestStockSchema,
  type ToolRequest,
  type RequestSummary,
} from '../../shared/requests';
import { api, ApiError, jsonBody } from '../api';
import { useAuth, useFormat } from '../context';
import { Page } from '../components/Page';
import { RequestStatusBadge, ToolPhoto } from '../components/ToolRequest';
import {
  Button,
  Dialog,
  EmptyState,
  ErrorBanner,
  Field,
  Pagination,
  Search,
  Select,
  Skeleton,
  useToast,
} from '../components/ui';

type Action = 'cancel' | 'approve' | 'reject' | 'issue' | 'return';
const actionLabels: Record<Action, string> = {
  cancel: 'Cancel request',
  approve: 'Approve request',
  reject: 'Reject request',
  issue: 'Issue tools',
  return: 'Record return',
};

export function RequestsPage() {
  const { user } = useAuth();
  const admin = user?.role === 'Admin';
  const format = useFormat();
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState<{ row: ToolRequest; action: Action } | null>(null);
  const summaryRef = useRef<HTMLSpanElement>(null);
  const [completed, setCompleted] = useState(0);
  const page = Math.max(1, Number(params.get('page') || 1) || 1);
  const status = params.get('status') || 'all';
  const q = params.get('q') || '';
  const requestId = params.get('requestId') || '';
  const search = new URLSearchParams({
    page: String(page),
    pageSize: '12',
    q,
    status,
    ...(requestId ? { requestId } : {}),
  }).toString();
  const query = useQuery({
    queryKey: ['requests', search],
    queryFn: ({ signal }) => api<PageData<ToolRequest>>(`/requests?${search}`, { signal }),
    refetchInterval: 20000,
    placeholderData: (previous) => previous,
  });
  const summary = useQuery({
    queryKey: ['request-summary'],
    queryFn: ({ signal }) => api<RequestSummary>('/requests/summary', { signal }),
    refetchInterval: 20000,
  });
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== 'all') next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: key === 'q' });
  };
  useEffect(() => {
    if (completed) summaryRef.current?.focus();
  }, [completed]);
  // Keep the attempt's version stable even if polling observes a committed action
  // whose response was lost. Retrying the same body must keep its idempotency key.
  const active = selected?.row;
  return (
    <Page
      title="Tool requests"
      eyebrow={admin ? 'REQUEST MONITORING' : 'MY REQUESTS'}
      description={
        admin
          ? 'Review requests, record issues and monitor who has each tool or jig.'
          : user?.role === 'Viewer'
            ? 'Review the status and quantities of your earlier tool requests.'
            : 'Request tools and jigs, follow their status, and cancel before they are issued.'
      }
      actions={
        <Link className="button primary solid" to="/inventory">
          <Package size={17} />
          Browse tools
        </Link>
      }
    >
      {summary.isError && (
        <ErrorBanner message={summary.error.message} retry={() => void summary.refetch()} />
      )}
      <section
        className="request-stats"
        aria-label={admin ? 'All request totals' : 'My request totals'}
      >
        <div>
          <ClipboardList size={21} aria-hidden="true" />
          <span>Pending review</span>
          <strong>{summary.data ? format.number(summary.data.pending) : '—'}</strong>
        </div>
        <div>
          <Package size={21} aria-hidden="true" />
          <span>Approved, awaiting issue</span>
          <strong>{summary.data ? format.number(summary.data.approved) : '—'}</strong>
        </div>
        <div>
          <ArrowDownLeft size={21} aria-hidden="true" />
          <span>Units in use</span>
          <strong>{summary.data ? format.number(summary.data.outstanding_quantity) : '—'}</strong>
        </div>
      </section>
      <p className="muted request-policy">
        Requests do not reserve stock. An Admin checks availability when issuing tools. Issued tools
        can be returned through the Admin.
      </p>
      <section className="panel requests-panel">
        <div className="requests-toolbar">
          <Search
            value={q}
            label="Search requests"
            placeholder={admin ? 'Find a tool, SKU or requester…' : 'Find a tool or SKU…'}
            onCommit={(value) => update('q', value)}
          />
          <Select
            label="Request status"
            value={status}
            onChange={(event) => update('status', event.target.value)}
          >
            <option value="all">All statuses</option>
            {requestStatuses.map((value) => (
              <option key={value} value={value}>
                {value === 'pending'
                  ? 'Pending review'
                  : value === 'issued'
                    ? 'In use'
                    : value[0].toUpperCase() + value.slice(1)}
              </option>
            ))}
          </Select>
        </div>
        {requestId && (
          <div className="request-filter-note">
            <span>Showing the selected request</span>
            <Button emphasis="ghost" onClick={() => update('requestId', '')}>
              <X size={15} />
              Show all requests
            </Button>
          </div>
        )}
        <div className="table-summary">
          <span tabIndex={-1} ref={summaryRef}>
            <strong>{query.data?.total ?? '—'}</strong>{' '}
            {admin ? (query.data?.total === 1 ? 'request' : 'requests') : 'of your requests'}
          </span>
          <span className="muted">Updates automatically</span>
        </div>
        {query.isPending ? (
          <Skeleton rows={5} />
        ) : query.isError ? (
          <ErrorBanner message={query.error.message} retry={() => void query.refetch()} />
        ) : !query.data?.data.length ? (
          <EmptyState
            title={
              q || status !== 'all' || requestId ? 'No matching requests' : 'No tool requests yet'
            }
            description={
              q || status !== 'all' || requestId
                ? 'Change the filters to find other requests.'
                : admin
                  ? 'Requests from your users will appear here for review.'
                  : user?.role === 'Viewer'
                    ? 'This account has read-only access. Earlier requests will appear here.'
                    : 'Browse the catalog, choose a tool or jig, and enter the quantity you need.'
            }
            action={
              <Link className="button neutral outline" to="/inventory">
                Browse tools
              </Link>
            }
          />
        ) : (
          <div
            className={`table-scroll ${query.isFetching ? 'refreshing' : ''}`}
            aria-busy={query.isFetching}
          >
            <table className="data-table requests-table">
              <caption className="sr-only">
                {admin ? 'All tool and jig requests' : 'My tool and jig requests'}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Tool / jig</th>
                  {admin && <th scope="col">Requested by</th>}
                  <th scope="col">Quantities</th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {query.data.data.map((row) => (
                  <tr key={row.id}>
                    <td data-label="Tool / jig">
                      <div className="request-item-preview">
                        <ToolPhoto src={row.image_url} name={row.name} />
                        <div>
                          <Link to={`/inventory/${row.item_id}`} className="item-name">
                            {row.name}
                          </Link>
                          <span className="sku">{row.sku}</span>
                          <small>{format.number(row.available_quantity)} available now</small>
                        </div>
                      </div>
                      <details className="request-details">
                        <summary>Request details</summary>
                        <p>{row.purpose}</p>
                        {row.decision_note && (
                          <p>
                            <strong>Note:</strong> {row.decision_note}
                          </p>
                        )}
                        <small className="muted">Requested {format.date(row.created_at)}</small>
                      </details>
                    </td>
                    {admin && (
                      <td data-label="Requested by">
                        <strong>{row.requester}</strong>
                      </td>
                    )}
                    <td data-label="Quantities">
                      <dl className="request-quantities">
                        <div>
                          <dt>Requested</dt>
                          <dd>{format.number(row.quantity)}</dd>
                        </div>
                        <div>
                          <dt>Issued</dt>
                          <dd>{format.number(row.issued_quantity)}</dd>
                        </div>
                        <div>
                          <dt>Returned</dt>
                          <dd>{format.number(row.returned_quantity)}</dd>
                        </div>
                        <div>
                          <dt>In use</dt>
                          <dd>{format.number(row.issued_quantity - row.returned_quantity)}</dd>
                        </div>
                      </dl>
                    </td>
                    <td data-label="Status">
                      <RequestStatusBadge status={row.status} />
                    </td>
                    <td data-label="Actions">
                      <div className="request-row-actions">
                        {admin && row.status === 'pending' && (
                          <>
                            <Button
                              intent="primary"
                              onClick={() => setSelected({ row, action: 'approve' })}
                            >
                              Approve request
                            </Button>
                            <Button
                              intent="danger"
                              emphasis="ghost"
                              onClick={() => setSelected({ row, action: 'reject' })}
                            >
                              Reject request
                            </Button>
                          </>
                        )}
                        {admin && row.status === 'approved' && (
                          <>
                            <Button
                              intent="primary"
                              disabled={row.available_quantity < 1}
                              onClick={() => setSelected({ row, action: 'issue' })}
                            >
                              Issue tools
                            </Button>
                            {row.available_quantity < 1 && (
                              <small className="muted">Restock before issuing.</small>
                            )}
                            <Button
                              intent="danger"
                              emphasis="ghost"
                              onClick={() => setSelected({ row, action: 'reject' })}
                            >
                              Reject request
                            </Button>
                          </>
                        )}
                        {admin &&
                          row.status === 'issued' &&
                          row.issued_quantity > row.returned_quantity && (
                            <Button onClick={() => setSelected({ row, action: 'return' })}>
                              Record return
                            </Button>
                          )}
                        {user?.role !== 'Viewer' &&
                          row.requester_id === user?.id &&
                          ['pending', 'approved'].includes(row.status) && (
                            <Button
                              intent="danger"
                              emphasis="ghost"
                              onClick={() => setSelected({ row, action: 'cancel' })}
                            >
                              Cancel request
                            </Button>
                          )}
                        {!admin && row.status === 'issued' && (
                          <small className="muted">Contact an Admin to record a return.</small>
                        )}
                        {['returned', 'cancelled', 'rejected'].includes(row.status) && (
                          <span className="muted">No further action</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {query.data && (
          <Pagination
            total={query.data.total}
            page={page}
            pageSize={12}
            onChange={(value) => update('page', String(value))}
          />
        )}
      </section>
      {selected && active && (
        <RequestActionDialog
          request={active}
          action={selected.action}
          onClose={() => setSelected(null)}
          onSuccess={() => {
            setSelected(null);
            setCompleted((value) => value + 1);
          }}
        />
      )}
    </Page>
  );
}

function RequestActionDialog({
  request,
  action,
  onClose,
  onSuccess,
}: {
  request: ToolRequest;
  action: Action;
  onClose(): void;
  onSuccess(): void;
}) {
  const stock = action === 'issue' || action === 'return';
  const max =
    action === 'issue'
      ? Math.min(request.quantity, request.available_quantity)
      : request.issued_quantity - request.returned_quantity;
  const [quantity, setQuantity] = useState(String(stock ? max : 1));
  const [serialText, setSerialText] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [noteError, setNoteError] = useState('');
  const quantityRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const client = useQueryClient();
  const toast = useToast();
  const format = useFormat();
  const label = actionLabels[action];
  const mutation = useMutation({
    mutationFn: async (body: unknown) => {
      const signature = JSON.stringify(body);
      if (attempt.current?.signature !== signature)
        attempt.current = { signature, key: crypto.randomUUID() };
      return api<ToolRequest>(`/requests/${request.id}/${action}`, {
        method: 'POST',
        headers: { 'Idempotency-Key': attempt.current.key },
        body: jsonBody(body),
      });
    },
    onSuccess: async () => {
      await Promise.all(
        [
          'requests',
          'request-summary',
          'notifications',
          'items',
          'item',
          'dashboard',
          'movements',
        ].map((key) => client.invalidateQueries({ queryKey: [key] })),
      );
      toast(
        action === 'issue'
          ? 'Tools issued. Inventory updated.'
          : action === 'return'
            ? 'Return recorded. Inventory updated.'
            : action === 'cancel'
              ? 'Tool request cancelled.'
              : action === 'approve'
                ? 'Request approved. Stock changes when tools are issued.'
                : 'Tool request rejected.',
      );
      onSuccess();
    },
    onError: async (err: Error) => {
      setError(
        err instanceof ApiError && err.code === 'VERSION_CONFLICT'
          ? `${err.message} Close this dialog and reopen the request to review the latest record.`
          : err.message,
      );
      if (err instanceof ApiError && err.status === 409)
        await client.invalidateQueries({ queryKey: ['requests'] });
    },
  });
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    setFieldError('');
    setNoteError('');
    if (action === 'reject' && note.trim().length < 3) {
      setNoteError('Give a rejection reason of at least 3 characters.');
      noteRef.current?.focus();
      return;
    }
    const result = stock
      ? requestStockSchema.safeParse({
          version: request.version,
          quantity,
          serials: serialText
            .split(/[\n,]+/)
            .map((value) => value.trim())
            .filter(Boolean),
          note,
        })
      : requestActionSchema.safeParse({ version: request.version, note });
    if (!result.success) {
      setFieldError(result.error.issues[0].message);
      quantityRef.current?.focus();
      return;
    }
    if (stock && Number(quantity) > max) {
      setFieldError(`Enter at most ${format.number(max)} units.`);
      quantityRef.current?.focus();
      return;
    }
    mutation.mutate(result.data);
  };
  return (
    <Dialog
      open
      title={label}
      description={`${request.name} · ${request.sku} · Requested by ${request.requester}`}
      onClose={onClose}
      busy={mutation.isPending}
    >
      <form noValidate onSubmit={submit} className="form-stack">
        <div className="request-item-preview">
          <ToolPhoto src={request.image_url} name={request.name} />
          <div>
            <strong>{format.number(request.quantity)} units requested</strong>
            <small>{format.number(request.available_quantity)} available now</small>
            <small>
              {format.number(request.issued_quantity - request.returned_quantity)} still with the
              user
            </small>
          </div>
        </div>
        {error && <ErrorBanner message={error} />}
        {stock ? (
          <>
            <Field
              ref={quantityRef}
              autoFocus
              label={action === 'issue' ? 'Quantity to issue' : 'Quantity returned'}
              type="number"
              inputMode="numeric"
              required
              min={1}
              max={max}
              step={1}
              value={quantity}
              disabled={mutation.isPending}
              error={fieldError}
              onChange={(event) => setQuantity(event.target.value)}
            />
            {request.serialized && (
              <div className="field">
                <label htmlFor="request-action-serials">Serial numbers</label>
                <textarea
                  id="request-action-serials"
                  className="resize-none"
                  rows={3}
                  value={serialText}
                  disabled={mutation.isPending}
                  onChange={(event) => setSerialText(event.target.value)}
                  aria-describedby="request-action-serials-help"
                />
                <small id="request-action-serials-help">
                  Enter one {action === 'return' ? 'issued' : 'available'} serial number per unit,
                  separated by new lines or commas.
                </small>
              </div>
            )}
            <p className="muted request-note">
              {action === 'issue'
                ? 'This records the handover and deducts the issued quantity from inventory. The request closes for further issues, even when fewer units are issued.'
                : 'This records the tools received back and adds the returned quantity to inventory.'}
            </p>
          </>
        ) : (
          <p className="request-note">
            {action === 'cancel'
              ? 'Cancel this request? The Admin will be notified. Inventory will not change.'
              : action === 'approve'
                ? 'Approve this request for issue? Stock is checked and deducted separately when you hand over the tools.'
                : 'Reject this request? The user will be notified and inventory will not change.'}
          </p>
        )}
        <div className="field">
          <label htmlFor="request-action-note">
            {action === 'reject'
              ? 'Rejection reason'
              : action === 'cancel'
                ? 'Cancellation note (optional)'
                : 'Admin note (optional)'}
            {action === 'reject' && <span aria-hidden="true"> *</span>}
          </label>
          <textarea
            id="request-action-note"
            className="resize-none"
            ref={noteRef}
            required={action === 'reject'}
            aria-invalid={!!noteError}
            aria-describedby={noteError ? 'request-action-note-error' : undefined}
            rows={2}
            maxLength={1000}
            value={note}
            disabled={mutation.isPending}
            onChange={(event) => setNote(event.target.value)}
          />
          {noteError && (
            <small className="field-error" id="request-action-note-error">
              {noteError}
            </small>
          )}
        </div>
        <div className="dialog-actions">
          <Button autoFocus={!stock} disabled={mutation.isPending} onClick={onClose}>
            Back
          </Button>
          <Button
            type="submit"
            intent={action === 'cancel' || action === 'reject' ? 'danger' : 'primary'}
            emphasis="solid"
            busy={mutation.isPending}
          >
            {label}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
