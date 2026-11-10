import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Archive,
  Download,
  FileText,
  Package,
  Pencil,
  Plus,
  RotateCcw,
  Upload,
} from 'lucide-react';
import type { Item, Page as PageData } from '../../shared/contracts';
import { api, download } from '../api';
import { useAuth, useFormat } from '../context';
import { Page } from '../components/Page';
import {
  Button,
  EmptyState,
  ErrorBanner,
  Pagination,
  Search,
  Select,
  Skeleton,
  StatusBadge,
  useToast,
} from '../components/ui';
import { StockDialog } from '../components/StockDialog';
import { ImportDialog } from '../components/ImportDialog';
import { ArchiveItemDialog, useItemLifecycle } from '../components/ItemLifecycle';
import { ToolRequestDialog } from '../components/ToolRequest';

export function InventoryPage() {
  const [params, setParams] = useSearchParams();
  const { user } = useAuth();
  const location = useLocation();
  const format = useFormat();
  const toast = useToast();
  const [stockItem, setStockItem] = useState<Item | null>(null);
  const [requestItem, setRequestItem] = useState<Item | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [archiveItem, setArchiveItem] = useState<Item | null>(null);
  const summaryRef = useRef<HTMLSpanElement>(null);
  const [completedActions, setCompletedActions] = useState(0);
  const lifecycle = useItemLifecycle({
    onSuccess: () => {
      setArchiveItem(null);
      setCompletedActions((count) => count + 1);
    },
    onError: (error) => setActionError(error.message),
  });
  useEffect(() => {
    if (completedActions > 0) {
      summaryRef.current?.focus();
    }
  }, [completedActions]);
  const requestedSort = params.get('sort');
  useEffect(() => {
    if (requestedSort !== 'unit_price') return;
    const next = new URLSearchParams(params);
    next.set('sort', 'name');
    setParams(next, { replace: true });
  }, [params, requestedSort, setParams]);
  const filters = {
    q: params.get('q') || '',
    category: params.get('category') || '',
    stock: params.get('stock') || 'all',
    status: user?.role === 'Staff' ? 'active' : params.get('status') || 'active',
    sort: requestedSort === 'unit_price' ? 'name' : requestedSort || 'name',
    direction: params.get('direction') || 'asc',
    page: params.get('page') || '1',
    pageSize: '12',
  };
  const search = new URLSearchParams(filters).toString();
  const query = useQuery({
    queryKey: ['items', search],
    queryFn: ({ signal }) => api<PageData<Item>>(`/items?${search}`, { signal }),
    placeholderData: (previous) => previous,
  });
  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: ({ signal }) => api<string[]>('/categories', { signal }),
  });
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== 'all') next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: key === 'q' });
  };
  const sort = (key: string) => {
    const next = new URLSearchParams(params);
    next.set('sort', key);
    next.set('direction', filters.sort === key && filters.direction === 'asc' ? 'desc' : 'asc');
    next.delete('page');
    setParams(next);
  };
  const editable = ['Admin', 'Manager'].includes(user!.role);
  const operable = editable;
  const requestable = user!.role !== 'Viewer';
  const exportFile = async (pdf = false) => {
    setExportBusy(true);
    setActionError('');
    try {
      await download(
        pdf ? '/reports/stock' : `/exports/items.csv?${search}`,
        pdf ? 'SDP-Stock-report.pdf' : 'SDP-Inventory.csv',
        pdf ? { filters } : undefined,
      );
      toast(pdf ? 'Stock report downloaded.' : 'Inventory exported.');
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setExportBusy(false);
    }
  };
  const sortHeading = (name: string, label: string) => (
    <th
      scope="col"
      aria-sort={
        filters.sort === name
          ? filters.direction === 'asc'
            ? 'ascending'
            : 'descending'
          : undefined
      }
    >
      <button type="button" className="sort-button" onClick={() => sort(name)}>
        {label}
        {filters.sort === name ? (
          filters.direction === 'asc' ? (
            <ArrowUp size={13} />
          ) : (
            <ArrowDown size={13} />
          )
        ) : (
          <ArrowUpDown size={13} />
        )}
      </button>
    </th>
  );
  return (
    <Page
      title={user?.role === 'Staff' ? 'Tool catalog' : 'Inventory'}
      eyebrow="TOOLS, JIGS & INVENTORY"
      description={
        user?.role === 'Staff'
          ? 'Choose a tool or jig, review its photos and request the quantity you need.'
          : 'Your production inventory, organized and accounted for.'
      }
      actions={
        <>
          {user?.role !== 'Staff' && (
            <Button busy={exportBusy} onClick={() => void exportFile()}>
              <Download size={16} />
              Export CSV
            </Button>
          )}
          {editable && (
            <>
              <Button onClick={() => setImportOpen(true)}>
                <Upload size={16} />
                Import
              </Button>
              <Link
                className="button primary solid"
                to="/inventory/new"
                state={{ returnTo: location.pathname + location.search }}
              >
                <Plus size={17} />
                Add item
              </Link>
            </>
          )}
        </>
      }
    >
      {actionError && !archiveItem && <ErrorBanner message={actionError} />}
      <section className="panel inventory-panel">
        <div className="inventory-toolbar">
          <Search value={filters.q} onCommit={(value) => update('q', value)} />
          <Select
            label="Category"
            value={filters.category}
            onChange={(event) => update('category', event.target.value)}
          >
            <option value="">All categories</option>
            {categories.data?.map((category) => (
              <option key={category}>{category}</option>
            ))}
          </Select>
          <Select
            label="Stock level"
            value={filters.stock}
            onChange={(event) => update('stock', event.target.value)}
          >
            <option value="all">All stock levels</option>
            <option value="in">In stock</option>
            <option value="low">Low stock</option>
            <option value="out">Out of stock</option>
          </Select>
          {user?.role !== 'Staff' && (
            <Select
              label="Status"
              value={filters.status}
              onChange={(event) => update('status', event.target.value)}
            >
              <option value="active">Active items</option>
              <option value="archived">Archived items</option>
              <option value="all">All items</option>
            </Select>
          )}
        </div>
        <div className="table-summary">
          <span ref={summaryRef} tabIndex={-1}>
            <strong>{query.data?.total ?? '—'}</strong> items
            {filters.q && ` matching “${filters.q}”`}
          </span>
          {user?.role !== 'Staff' && (
            <Button emphasis="ghost" busy={exportBusy} onClick={() => void exportFile(true)}>
              <FileText size={15} />
              Stock report
            </Button>
          )}
        </div>
        {query.isPending ? (
          <Skeleton rows={6} />
        ) : query.isError ? (
          <ErrorBanner message={query.error.message} retry={() => void query.refetch()} />
        ) : !query.data?.data.length ? (
          <EmptyState
            title={
              filters.q || filters.category || filters.stock !== 'all'
                ? 'No matching items'
                : 'Your inventory starts here'
            }
            description={
              filters.q || filters.category || filters.stock !== 'all'
                ? 'Change your search or clear the filters to see more items.'
                : editable
                  ? 'Add an item to start tracking its stock and movements.'
                  : 'Your Admin will add tools and jigs to the catalog.'
            }
            action={<Button onClick={() => setParams({})}>Clear filters</Button>}
          />
        ) : (
          <div
            className={`table-scroll ${query.isFetching ? 'refreshing' : ''}`}
            aria-busy={query.isFetching}
          >
            <table className="data-table inventory-table">
              <caption className="sr-only">Production inventory</caption>
              <thead>
                <tr>
                  {sortHeading('name', 'Item')}
                  {sortHeading('sku', 'SKU')}
                  <th scope="col">Category</th>
                  {sortHeading('quantity', 'Stock')}
                  <th scope="col">Stock status</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {query.data.data.map((item) => (
                  <tr key={item.id}>
                    <td data-label="Item">
                      <div className="item-cell">
                        {item.image_url ? (
                          <img
                            src={item.image_url}
                            alt=""
                            loading="lazy"
                            width={42}
                            height={42}
                            onError={(event) => {
                              event.currentTarget.style.visibility = 'hidden';
                            }}
                          />
                        ) : (
                          <span className="part-icon">
                            <Package size={20} aria-hidden="true" />
                          </span>
                        )}
                        <div>
                          <Link
                            to={`/inventory/${item.id}`}
                            state={{ returnTo: location.pathname + location.search }}
                            className="item-name"
                          >
                            {item.name}
                          </Link>
                          <small className="muted">{item.supplier || 'No supplier'}</small>
                          {item.status === 'archived' && <small className="muted">Archived</small>}
                        </div>
                      </div>
                    </td>
                    <td data-label="SKU" className="mono">
                      {item.sku}
                    </td>
                    <td data-label="Category">
                      <span className="category-chip">{item.category}</span>
                    </td>
                    <td data-label="Stock">
                      <strong className="stock-number">{format.number(item.quantity)}</strong>
                      <small className="block muted">
                        Reorder at {format.number(item.reorder_level)}
                      </small>
                    </td>
                    <td data-label="Stock status">
                      <StatusBadge item={item} />
                    </td>
                    <td data-label="Actions">
                      <div className="inventory-row-actions">
                        {requestable && item.status === 'active' && (
                          <Button
                            emphasis="ghost"
                            className="row-action"
                            aria-label={`Request ${item.name}`}
                            disabled={item.quantity < 1}
                            onClick={() => setRequestItem(item)}
                          >
                            Request tools
                          </Button>
                        )}
                        {operable && item.status === 'active' ? (
                          <Button
                            emphasis="ghost"
                            className="row-action"
                            onClick={() => setStockItem(item)}
                          >
                            Manage stock
                          </Button>
                        ) : (
                          <Link to={`/inventory/${item.id}`} className="text-link">
                            View item
                          </Link>
                        )}
                        {editable && (
                          <div className="item-record-actions">
                            {item.status === 'active' ? (
                              <>
                                <Link
                                  to={`/inventory/${item.id}/edit`}
                                  state={{ returnTo: location.pathname + location.search }}
                                  className="button neutral ghost row-action"
                                  aria-label={`Edit ${item.name}`}
                                >
                                  <Pencil size={14} aria-hidden="true" />
                                  Edit item
                                </Link>
                                <Button
                                  intent="danger"
                                  emphasis="ghost"
                                  className="row-action"
                                  aria-label={`Archive ${item.name}`}
                                  disabled={lifecycle.isPending}
                                  onClick={() => {
                                    lifecycle.reset();
                                    setActionError('');
                                    setArchiveItem(item);
                                  }}
                                >
                                  <Archive size={14} aria-hidden="true" />
                                  Archive item
                                </Button>
                              </>
                            ) : (
                              <Button
                                emphasis="ghost"
                                className="row-action"
                                aria-label={`Restore ${item.name}`}
                                disabled={lifecycle.isPending}
                                busy={
                                  lifecycle.isPending && lifecycle.variables?.item.id === item.id
                                }
                                onClick={() => {
                                  setActionError('');
                                  lifecycle.mutate({ item, action: 'restore' });
                                }}
                              >
                                <RotateCcw size={14} aria-hidden="true" />
                                Restore item
                              </Button>
                            )}
                          </div>
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
            page={query.data.page}
            pageSize={12}
            onChange={(page) => update('page', String(page))}
          />
        )}
      </section>
      <StockDialog item={stockItem} onClose={() => setStockItem(null)} />
      <ToolRequestDialog item={requestItem} onClose={() => setRequestItem(null)} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
      <ArchiveItemDialog
        item={archiveItem}
        onConfirm={() => {
          if (archiveItem) lifecycle.mutate({ item: archiveItem, action: 'archive' });
        }}
        onClose={() => {
          setArchiveItem(null);
          setActionError('');
          lifecycle.reset();
        }}
        busy={lifecycle.isPending}
        error={lifecycle.error?.message}
      />
    </Page>
  );
}
