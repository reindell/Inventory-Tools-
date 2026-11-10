import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  Archive,
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  ImagePlus,
  Package,
  Pencil,
  Printer,
  RotateCcw,
  Trash2,
  ZoomIn,
} from 'lucide-react';
import type { ItemDetail, ItemImage, Page as PageData, SerialUnit } from '../../shared/contracts';
import { api, download, jsonBody, uploadFile } from '../api';
import { useAuth, useFormat } from '../context';
import { Page } from '../components/Page';
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBanner,
  Pagination,
  Search,
  Skeleton,
  StatusBadge,
  useToast,
} from '../components/ui';
import { StockDialog } from '../components/StockDialog';
import { MovementTable } from '../components/MovementTable';
import { ArchiveItemDialog, useItemLifecycle } from '../components/ItemLifecycle';
import { ToolRequestDialog } from '../components/ToolRequest';

export function ItemDetailPage() {
  const { id } = useParams();
  const location = useLocation();
  const { user } = useAuth();
  const format = useFormat();
  const client = useQueryClient();
  const toast = useToast();
  const [stockOpen, setStockOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [deleteImage, setDeleteImage] = useState<ItemImage | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [selectedImage, setSelectedImage] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [includeLogo, setIncludeLogo] = useState(true);
  const stockHeadingRef = useRef<HTMLHeadingElement>(null);
  const [completedActions, setCompletedActions] = useState(0);
  const query = useQuery({
    queryKey: ['item', id],
    queryFn: ({ signal }) => api<ItemDetail>(`/items/${id}`, { signal }),
    refetchInterval: 60000,
  });
  const data = query.data;
  const editable = ['Admin', 'Manager'].includes(user!.role);
  const returnTo = (location.state as { returnTo?: string })?.returnTo || '/inventory';
  const archive = useItemLifecycle({
    onSuccess: () => {
      setArchiveOpen(false);
      setCompletedActions((count) => count + 1);
    },
    onError: (err) => setError(err.message),
  });
  useEffect(() => {
    if (completedActions > 0) stockHeadingRef.current?.focus();
  }, [completedActions]);
  const remove = useMutation({
    mutationFn: () => api(`/items/${id}/images/${deleteImage!.id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      setDeleteImage(null);
      setSelectedImage(0);
      await client.invalidateQueries();
      toast('Image removed.');
    },
    onError: (err) => setError(err.message),
  });
  const upload = async (files: FileList | null) => {
    if (!files?.length || !data) return;
    setError('');
    const list = Array.from(files);
    if (list.length + data.images.length > 5) {
      setError('An item can have up to five images.');
      return;
    }
    if (
      list.some(
        (file) =>
          file.size > 10 * 1024 * 1024 ||
          !['image/png', 'image/jpeg', 'image/webp'].includes(file.type),
      )
    ) {
      setError('Choose PNG, JPEG or WebP images, each 10 MiB or smaller.');
      return;
    }
    setBusy(true);
    try {
      for (const [index, file] of list.entries())
        await uploadFile(`/items/${id}/images`, file, (percent) =>
          setProgress(Math.round((index * 100 + percent) / list.length)),
        );
      toast('Images uploaded.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      await client.invalidateQueries({ queryKey: ['item', id] });
      await client.invalidateQueries({ queryKey: ['items'] });
      setBusy(false);
    }
  };
  const reorder = async (image: ItemImage, direction: number | 'primary') => {
    if (!data) return;
    setBusy(true);
    setError('');
    const ids = data.images.map((image) => image.id);
    const index = ids.indexOf(image.id);
    if (typeof direction === 'number')
      [ids[index], ids[index + direction]] = [ids[index + direction], ids[index]];
    try {
      await api(`/items/${id}/images`, {
        method: 'PATCH',
        body: jsonBody({
          ids,
          primaryId:
            direction === 'primary' ? image.id : data.images.find((image) => image.is_primary)!.id,
        }),
      });
      await client.invalidateQueries();
      toast('Images updated.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const print = async () => {
    setBusy(true);
    setError('');
    try {
      await download('/labels', 'SDP-SKU-label.pdf', { ids: [id], includeLogo });
      toast('Printable label downloaded.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page
      title={data?.item.name || 'Item detail'}
      eyebrow="INVENTORY / ITEM DETAIL"
      description={data?.item.sku}
      actions={
        <>
          <Link to={returnTo} className="button neutral outline">
            <ArrowLeft size={16} />
            Inventory
          </Link>
          {data && editable && data.item.status === 'active' && (
            <Link
              className="button neutral outline"
              to={`/inventory/${id}/edit`}
              state={{ returnTo }}
            >
              <Pencil size={16} />
              Edit item
            </Link>
          )}
          {data && user!.role !== 'Viewer' && data.item.status === 'active' && (
            <Button
              intent="primary"
              disabled={data.item.quantity < 1}
              onClick={() => setRequestOpen(true)}
            >
              Request tools
            </Button>
          )}
          {data && editable && data.item.status === 'active' && (
            <Button intent="primary" onClick={() => setStockOpen(true)}>
              Manage stock
            </Button>
          )}
        </>
      }
    >
      {query.isPending ? (
        <Skeleton rows={6} />
      ) : query.isError ? (
        <ErrorBanner message={query.error.message} retry={() => void query.refetch()} />
      ) : (
        data && (
          <>
            {error && <ErrorBanner message={error} />}
            {data.item.status === 'archived' && (
              <div className="draft-banner">
                <p>This item is archived. Its stock history is preserved.</p>
                {editable && (
                  <Button
                    busy={archive.isPending}
                    onClick={() => archive.mutate({ item: data.item, action: 'restore' })}
                  >
                    <RotateCcw size={16} />
                    Restore item
                  </Button>
                )}
              </div>
            )}
            <div className="item-detail-grid">
              <section className="panel image-panel">
                <div className="gallery-main">
                  {data.images.length ? (
                    <button
                      type="button"
                      className="zoom-trigger"
                      onClick={() => setZoom(Math.min(selectedImage, data.images.length - 1))}
                      aria-label="Zoom item image"
                    >
                      <img
                        src={data.images[Math.min(selectedImage, data.images.length - 1)].url}
                        alt={data.item.name}
                        width={480}
                        height={360}
                      />
                      <span>
                        <ZoomIn size={18} />
                        Zoom
                      </span>
                    </button>
                  ) : (
                    <div className="image-placeholder">
                      <Package size={64} strokeWidth={1} />
                      <span>No photos yet</span>
                    </div>
                  )}
                </div>
                {data.images.length > 0 && (
                  <div className="gallery-thumbnails">
                    {data.images.map((image, index) => (
                      <button
                        type="button"
                        aria-label={`View image ${index + 1}`}
                        aria-pressed={selectedImage === index}
                        key={image.id}
                        onClick={() => setSelectedImage(index)}
                      >
                        <img src={image.thumbnailUrl} alt="" width={64} height={64} />
                      </button>
                    ))}
                  </div>
                )}
                {editable && data.item.status === 'active' && (
                  <div className="image-management">
                    <div
                      className="upload-zone compact-upload"
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (!busy) void upload(event.dataTransfer.files);
                      }}
                    >
                      <ImagePlus size={23} />
                      <p>Drop photos here or choose files</p>
                      <small>PNG, JPEG, WebP · 10 MiB each · {data.images.length}/5 images</small>
                      <label
                        className={`button neutral outline file-picker ${busy || data.images.length >= 5 ? 'disabled' : ''}`}
                      >
                        Choose images
                        <input
                          type="file"
                          multiple
                          accept="image/png,image/jpeg,image/webp"
                          disabled={busy || data.images.length >= 5}
                          aria-label="Choose item images"
                          onChange={(event) => {
                            void upload(event.target.files);
                            event.target.value = '';
                          }}
                        />
                      </label>
                    </div>
                    {busy && (
                      <progress aria-label="Image upload progress" value={progress} max={100} />
                    )}
                    {data.images.map((image, index) => (
                      <div key={image.id} className="image-controls">
                        <span>
                          Image {index + 1}
                          {image.is_primary && <small> · Primary</small>}
                        </span>
                        <div>
                          <Button
                            emphasis="ghost"
                            aria-label={`Move image ${index + 1} up`}
                            disabled={busy || index === 0}
                            onClick={() => void reorder(image, -1)}
                          >
                            <ArrowUp size={14} />
                          </Button>
                          <Button
                            emphasis="ghost"
                            aria-label={`Move image ${index + 1} down`}
                            disabled={busy || index === data.images.length - 1}
                            onClick={() => void reorder(image, 1)}
                          >
                            <ArrowDown size={14} />
                          </Button>
                          <Button
                            emphasis="ghost"
                            disabled={busy || image.is_primary}
                            aria-label={`Set image ${index + 1} as primary`}
                            onClick={() => void reorder(image, 'primary')}
                          >
                            <Check size={14} />
                          </Button>
                          <Button
                            intent="danger"
                            emphasis="ghost"
                            disabled={busy}
                            aria-label={`Remove image ${index + 1}`}
                            onClick={() => {
                              setError('');
                              setDeleteImage(image);
                            }}
                          >
                            <Trash2 size={14} />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
              <div className="detail-info">
                <section className="panel form-panel">
                  <div className="detail-stock-heading">
                    <h2 ref={stockHeadingRef} tabIndex={-1}>
                      Stock position
                    </h2>
                    <StatusBadge item={data.item} />
                  </div>
                  <div className="detail-stock-value">
                    <strong>{format.number(data.item.quantity)}</strong>
                    <span>units available</span>
                  </div>
                  <div className="stock-level-track">
                    <span
                      style={{
                        width: `${Math.min(100, (data.item.quantity / Math.max(data.item.reorder_level * 3, 1)) * 100)}%`,
                      }}
                    />
                  </div>
                  <p className="muted">
                    Reorder level: {format.number(data.item.reorder_level)} units
                  </p>
                  <dl className="detail-dl">
                    <div>
                      <dt>Category</dt>
                      <dd>{data.item.category}</dd>
                    </div>
                    <div>
                      <dt>Supplier</dt>
                      <dd>{data.item.supplier || 'Not specified'}</dd>
                    </div>
                    <div>
                      <dt>Barcode</dt>
                      <dd className="mono">{data.item.barcode || 'Not assigned'}</dd>
                    </div>
                    <div>
                      <dt>Serial tracking</dt>
                      <dd>{data.item.serialized ? 'Enabled' : 'Not enabled'}</dd>
                    </div>
                  </dl>
                </section>
                <section className="panel form-panel">
                  <h2>Description</h2>
                  <p className="description-text">
                    {data.item.description || 'No description has been added.'}
                  </p>
                  {user?.role !== 'Staff' && (
                    <div className="label-actions">
                      <label className="checkbox-label">
                        <input
                          type="checkbox"
                          checked={includeLogo}
                          onChange={(event) => setIncludeLogo(event.target.checked)}
                        />
                        Include SDP logo on label
                      </label>
                      <Button busy={busy} onClick={() => void print()}>
                        <Printer size={16} />
                        Download printable label
                      </Button>
                    </div>
                  )}
                </section>
              </div>
            </div>
            {data.item.serialized && user?.role !== 'Staff' && <Serials itemId={data.item.id} />}
            {user?.role !== 'Staff' && (
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Stock history</h2>
                    <p>The latest 20 movements for this item</p>
                  </div>
                  <Link className="text-link" to={`/movements?itemId=${id}`}>
                    Full history
                  </Link>
                </div>
                <MovementTable rows={data.movements} />
              </section>
            )}
            {editable && data.item.status === 'active' && (
              <section className="archive-section">
                <div>
                  <h3>Archive this item</h3>
                  <p>
                    Keep its history while removing it from active inventory. Stock must be zero.
                  </p>
                </div>
                <Button
                  intent="danger"
                  onClick={() => {
                    setError('');
                    setArchiveOpen(true);
                  }}
                >
                  <Archive size={16} />
                  Archive item
                </Button>
              </section>
            )}
            <StockDialog item={stockOpen ? data.item : null} onClose={() => setStockOpen(false)} />
            <ToolRequestDialog
              item={requestOpen ? data.item : null}
              onClose={() => setRequestOpen(false)}
            />
            <Dialog
              open={zoom !== null}
              title={`${data.item.name} — image ${(zoom || 0) + 1}`}
              onClose={() => setZoom(null)}
              className="zoom-dialog"
            >
              <div
                className="zoom-content"
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight')
                    setZoom((value) => ((value || 0) + 1) % data.images.length);
                  if (event.key === 'ArrowLeft')
                    setZoom(
                      (value) => ((value || 0) - 1 + data.images.length) % data.images.length,
                    );
                }}
              >
                {zoom !== null && data.images[zoom] && (
                  <img src={data.images[zoom].url} alt={data.item.name} width={900} height={650} />
                )}
                {data.images.length > 1 && (
                  <div className="dialog-actions">
                    <Button
                      aria-label="Previous image"
                      onClick={() =>
                        setZoom(
                          (value) => ((value || 0) - 1 + data.images.length) % data.images.length,
                        )
                      }
                    >
                      <ChevronLeft size={20} />
                    </Button>
                    <Button
                      aria-label="Next image"
                      onClick={() => setZoom((value) => ((value || 0) + 1) % data.images.length)}
                    >
                      <ChevronRight size={20} />
                    </Button>
                  </div>
                )}
              </div>
            </Dialog>
            <ArchiveItemDialog
              item={archiveOpen ? data.item : null}
              onConfirm={() => archive.mutate({ item: data.item, action: 'archive' })}
              onClose={() => {
                setArchiveOpen(false);
                archive.reset();
              }}
              busy={archive.isPending}
              error={archive.error?.message}
            />
            <ConfirmDialog
              open={!!deleteImage}
              title="Remove this image?"
              description="This photo will be removed from the item gallery."
              confirmLabel="Remove image"
              onConfirm={() => remove.mutate()}
              onClose={() => setDeleteImage(null)}
              busy={remove.isPending}
              error={error}
            />
          </>
        )
      )}
    </Page>
  );
}
function Serials({ itemId }: { itemId: string }) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['serials', itemId, q, page],
    queryFn: ({ signal }) =>
      api<PageData<SerialUnit>>(
        `/items/${itemId}/serials?${new URLSearchParams({ q, page: String(page), pageSize: '12' })}`,
        { signal },
      ),
  });
  return (
    <section className="panel">
      <div className="panel-heading">
        <div>
          <h2>Serialized units</h2>
          <p>Individual unit status and identity</p>
        </div>
        <Search
          value={q}
          label="Search serial numbers"
          placeholder="Find a serial number…"
          onCommit={(value) => {
            setQ(value);
            setPage(1);
          }}
        />
      </div>
      {query.isPending ? (
        <Skeleton rows={3} />
      ) : query.isError ? (
        <ErrorBanner message={query.error.message} retry={() => void query.refetch()} />
      ) : !query.data?.data.length ? (
        <EmptyState
          title="No matching serial numbers"
          description="Serial numbers are registered when serialized stock is received."
        />
      ) : (
        <>
          <ul className="serial-list">
            {query.data.data.map((unit) => (
              <li key={unit.id}>
                <span className="mono">{unit.serial}</span>
                <span className={`serial-status ${unit.status}`}>
                  {unit.status === 'in_stock'
                    ? 'In stock'
                    : unit.status === 'sold'
                      ? 'Issued / sold'
                      : 'Damaged'}
                </span>
              </li>
            ))}
          </ul>
          <Pagination total={query.data.total} page={page} pageSize={12} onChange={setPage} />
        </>
      )}
    </section>
  );
}
