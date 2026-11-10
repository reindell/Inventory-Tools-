import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Package } from 'lucide-react';
import type { Item, Movement, Page as PageData } from '../../shared/contracts';
import { api } from '../api';
import { useAuth, useFormat } from '../context';
import { Page } from '../components/Page';
import {
  Button,
  EmptyState,
  ErrorBanner,
  Field,
  Pagination,
  Search,
  Select,
  Skeleton,
  StatusBadge,
} from '../components/ui';
import { MovementTable } from '../components/MovementTable';
import { StockDialog } from '../components/StockDialog';

export function MovementsPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const type = params.get('type') || 'all';
  const page = Number(params.get('page') || 1);
  const queryParams = new URLSearchParams(params);
  queryParams.set('pageSize', '12');
  const query = useQuery({
    queryKey: ['movements', queryParams.toString()],
    queryFn: ({ signal }) => api<PageData<Movement>>(`/movements?${queryParams}`, { signal }),
  });
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== 'all') next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: key === 'q' });
  };
  return (
    <Page
      title="Stock movements"
      eyebrow="THE PRODUCTION LEDGER"
      description="Follow every receipt, issue and adjustment, with a reason and a responsible person."
    >
      <section className="panel">
        <div className="inventory-toolbar">
          <Search
            value={q}
            label="Search movements"
            placeholder="Search item, SKU or reason…"
            onCommit={(value) => update('q', value)}
          />
          <Select
            label="Movement type"
            value={type}
            onChange={(event) => update('type', event.target.value)}
          >
            <option value="all">All movements</option>
            <option value="in">Stock in</option>
            <option value="out">Stock out</option>
            <option value="adjustment">Adjustment</option>
          </Select>
          <Field
            label="From date (UTC)"
            type="date"
            value={params.get('from') || ''}
            onChange={(event) => update('from', event.target.value)}
          />
          <Field
            label="To date (UTC)"
            type="date"
            value={params.get('to') || ''}
            onChange={(event) => update('to', event.target.value)}
          />
        </div>
        {params.get('itemId') && (
          <div className="table-summary">
            Showing one item’s history
            <Button emphasis="ghost" onClick={() => update('itemId', '')}>
              Show all items
            </Button>
          </div>
        )}
        {query.isPending ? (
          <Skeleton rows={6} />
        ) : query.isError ? (
          <ErrorBanner message={query.error.message} retry={() => void query.refetch()} />
        ) : (
          <>
            <MovementTable rows={query.data.data} />
            <Pagination
              total={query.data.total}
              page={page}
              pageSize={12}
              onChange={(value) => update('page', String(value))}
            />
          </>
        )}
      </section>
    </Page>
  );
}
export function AlertsPage() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get('page') || 1);
  const { user } = useAuth();
  const format = useFormat();
  const [item, setItem] = useState<Item | null>(null);
  const query = useQuery({
    queryKey: ['alerts', page],
    queryFn: ({ signal }) =>
      api<PageData<Item>>(`/alerts/low-stock?page=${page}&pageSize=12`, { signal }),
  });
  return (
    <Page
      title="Low-stock alerts"
      eyebrow="STOCK ATTENTION"
      description="Review parts that need replenishment before they affect production."
    >
      <section className="panel">
        {query.isPending ? (
          <Skeleton rows={5} />
        ) : query.isError ? (
          <ErrorBanner message={query.error.message} retry={() => void query.refetch()} />
        ) : !query.data.data.length ? (
          <EmptyState
            title="Stock levels look good"
            description="No active items are at or below their reorder level."
          />
        ) : (
          <>
            <ul className="alert-list">
              {query.data.data.map((item) => (
                <li key={item.id}>
                  <span className="part-icon">
                    <Package size={23} />
                  </span>
                  <div className="alert-part">
                    <Link className="item-name" to={`/inventory/${item.id}`}>
                      {item.name}
                    </Link>
                    <span className="sku">{item.sku}</span>
                  </div>
                  <div className="alert-count">
                    <strong>{format.number(item.quantity)} units</strong>
                    <small>Reorder at {format.number(item.reorder_level)}</small>
                  </div>
                  <StatusBadge item={item} />
                  {user!.role !== 'Viewer' && (
                    <Button onClick={() => setItem(item)}>Receive stock</Button>
                  )}
                </li>
              ))}
            </ul>
            <Pagination
              total={query.data.total}
              page={page}
              pageSize={12}
              onChange={(value) => setParams({ page: String(value) })}
            />
          </>
        )}
      </section>
      <StockDialog item={item} onClose={() => setItem(null)} />
    </Page>
  );
}
export function AuditPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const page = Number(params.get('page') || 1);
  const format = useFormat();
  const query = useQuery({
    queryKey: ['audit', q, page],
    queryFn: ({ signal }) =>
      api<PageData<any>>(
        `/audit-events?${new URLSearchParams({ q, page: String(page), pageSize: '12' })}`,
        { signal },
      ),
  });
  return (
    <Page
      title="Audit log"
      eyebrow="ACCOUNTABILITY"
      description="An immutable record of sensitive changes to stock, accounts and branding."
    >
      <section className="panel">
        <div className="inventory-toolbar">
          <Search
            value={q}
            label="Search audit actions"
            placeholder="Search actions, e.g. branding or stock…"
            onCommit={(value) => setParams(value ? { q: value } : {})}
          />
        </div>
        {query.isPending ? (
          <Skeleton rows={6} />
        ) : query.isError ? (
          <ErrorBanner message={query.error.message} retry={() => void query.refetch()} />
        ) : !query.data.data.length ? (
          <EmptyState title="No matching audit events" description="Try a different action name." />
        ) : (
          <>
            <div className="table-scroll">
              <table className="data-table">
                <caption className="sr-only">Audit events</caption>
                <thead>
                  <tr>
                    <th scope="col">Action</th>
                    <th scope="col">Actor</th>
                    <th scope="col">Record</th>
                    <th scope="col">Date & time</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.data.map((event) => (
                    <tr key={event.id}>
                      <td data-label="Action">
                        <strong className="mono">{event.action}</strong>
                        {event.after_data?.reason && (
                          <small className="block muted">{event.after_data.reason}</small>
                        )}
                      </td>
                      <td data-label="Actor">{event.actor}</td>
                      <td data-label="Record">
                        <span>{event.entity_type}</span>
                        <small className="block mono muted">{event.entity_id}</small>
                      </td>
                      <td data-label="Date & time" className="muted">
                        {format.date(event.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              total={query.data.total}
              page={page}
              pageSize={12}
              onChange={(value) => setParams({ ...(q ? { q } : {}), page: String(value) })}
            />
          </>
        )}
      </section>
    </Page>
  );
}
