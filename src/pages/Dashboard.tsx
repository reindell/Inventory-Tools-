import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  Box,
  CheckCircle2,
  Package,
  Plus,
} from 'lucide-react';
import { api } from '../api';
import { useAuth, useBrand, useFormat } from '../context';
import type { Item, Movement } from '../../shared/contracts';
import { Page } from '../components/Page';
import { EmptyState, ErrorBanner, Skeleton, StatusBadge } from '../components/ui';
import { MovementTable } from '../components/MovementTable';
interface DashboardData {
  totals: { items: number; units: string; low: number; out: number };
  low: Item[];
  recent: Movement[];
  top: { name: string; sku: string; units: number }[];
}
export function DashboardPage() {
  const { user } = useAuth();
  const { data: brand } = useBrand();
  const format = useFormat();
  const query = useQuery({
    queryKey: ['dashboard'],
    queryFn: ({ signal }) => api<DashboardData>('/dashboard', { signal }),
  });
  const data = query.data;
  return (
    <Page
      title="Dashboard"
      eyebrow="PRODUCTION OVERVIEW"
      description="A clear view of your stock and what needs attention."
      actions={
        <Link to="/inventory" className="button primary solid">
          <Package size={17} />
          View inventory
          <ArrowUpRight size={16} />
        </Link>
      }
    >
      {query.isPending ? (
        <Skeleton rows={4} />
      ) : query.isError ? (
        <ErrorBanner message={query.error.message} retry={() => void query.refetch()} />
      ) : (
        data && (
          <>
            <section className="overview-strip" aria-label="Production status">
              <div>
                <span className="status-dot" />
                <strong>{brand?.locationName || 'Production'}</strong>
                <span className="muted">Inventory workspace</span>
              </div>
              <span>
                {data.totals.low + data.totals.out
                  ? `${data.totals.low + data.totals.out} items need attention`
                  : 'Stock levels are healthy'}
                <span className="strip-divider">|</span>Single production location
              </span>
            </section>
            <div className="stats-grid">
              <Stat
                label="Active items"
                value={format.number(data.totals.items)}
                detail="Unique inventory records"
                icon={<Package />}
              />
              <Stat
                label="Units in stock"
                value={format.number(data.totals.units)}
                detail="Available for production"
                icon={<Box />}
              />
              <Stat
                label="In-stock items"
                value={format.number(data.totals.items - data.totals.low - data.totals.out)}
                detail="Above their reorder level"
                icon={<CheckCircle2 />}
              />
              <Stat
                label="Needs attention"
                value={format.number(data.totals.low + data.totals.out)}
                detail={`${data.totals.low} low stock · ${data.totals.out} out of stock`}
                icon={<AlertTriangle />}
                warning={data.totals.low + data.totals.out > 0}
              />
            </div>
            <div className="dashboard-columns">
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Stock attention</h2>
                    <p>Parts at or below their reorder level</p>
                  </div>
                  <Link to="/alerts" className="text-link">
                    View all
                    <ArrowRight size={16} />
                  </Link>
                </div>
                {data.low.length ? (
                  <ul className="attention-list">
                    {data.low.map((item) => (
                      <li key={item.id}>
                        <div className="part-icon">
                          <Package size={22} aria-hidden="true" />
                        </div>
                        <div className="attention-item">
                          <Link to={`/inventory/${item.id}`}>{item.name}</Link>
                          <span className="sku">{item.sku}</span>
                        </div>
                        <div className="attention-count">
                          <strong>
                            {format.number(item.quantity)}
                            <small> / {format.number(item.reorder_level)}</small>
                          </strong>
                          <StatusBadge item={item} />
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState
                    title="Stock levels look good"
                    description="No active items are below their reorder level."
                  />
                )}
              </section>
              <section className="panel top-moving">
                <div className="panel-heading">
                  <div>
                    <h2>Top-moving parts</h2>
                    <p>Units issued in the last 30 days</p>
                  </div>
                  <ArrowUpRight size={18} className="muted" />
                </div>
                {data.top.length ? (
                  <ul className="top-list">
                    {data.top.map((item, index) => (
                      <li key={item.sku}>
                        <div className="top-list-label">
                          <span className="ranking">{index + 1}</span>
                          <div>
                            <strong>{item.name}</strong>
                            <span className="sku">{item.sku}</span>
                          </div>
                          <strong>{format.number(item.units)}</strong>
                        </div>
                        <div className="bar-track">
                          <span style={{ width: `${(item.units / data.top[0].units) * 100}%` }} />
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState
                    title="Ready for your first issue"
                    description="Your most-issued parts will appear as stock moves into production."
                  />
                )}
              </section>
            </div>
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Recent stock movements</h2>
                  <p>Every receipt and issue, recorded</p>
                </div>
                <Link to="/movements" className="text-link">
                  View ledger
                  <ArrowRight size={16} />
                </Link>
              </div>
              <MovementTable rows={data.recent} compact />
            </section>
            {['Admin', 'Manager'].includes(user!.role) && (
              <div className="dashboard-footer-note">
                <Package size={18} />
                <p>Keep your production records complete. Add new parts before receiving stock.</p>
                <Link to="/inventory/new" className="text-link">
                  <Plus size={15} />
                  Add an item
                </Link>
              </div>
            )}
          </>
        )
      )}
    </Page>
  );
}
function Stat({
  label,
  value,
  detail,
  icon,
  warning = false,
}: {
  label: string;
  value: string;
  detail: string;
  icon: React.ReactNode;
  warning?: boolean;
}) {
  return (
    <section className={`stat-card ${warning ? 'warning-stat' : ''}`}>
      <div className="stat-heading">
        <span>{label}</span>
        <span className="stat-icon">{icon}</span>
      </div>
      <strong className="stat-value">{value}</strong>
      <small>{detail}</small>
    </section>
  );
}
