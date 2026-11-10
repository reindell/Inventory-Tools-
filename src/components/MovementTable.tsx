import { Link } from 'react-router-dom';
import { ArrowDownLeft, ArrowUpRight, SlidersHorizontal } from 'lucide-react';
import type { Movement } from '../../shared/contracts';
import { useFormat } from '../context';
import { EmptyState } from './ui';
export function MovementTable({ rows, compact = false }: { rows: Movement[]; compact?: boolean }) {
  const format = useFormat();
  if (!rows.length)
    return (
      <EmptyState
        title="No stock movements yet"
        description="Receipts, issues and adjustments will appear here."
      />
    );
  return (
    <div className="table-scroll">
      <table className={`data-table movement-table ${compact ? 'compact-table' : ''}`}>
        <caption className="sr-only">Stock movements</caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Movement</th>
            <th scope="col">Quantity</th>
            {!compact && (
              <>
                <th scope="col">Reason</th>
                <th scope="col">Recorded by</th>
              </>
            )}
            <th scope="col">Date & time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const Icon =
              row.type === 'in'
                ? ArrowDownLeft
                : row.type === 'out'
                  ? ArrowUpRight
                  : SlidersHorizontal;
            return (
              <tr key={row.id}>
                <td data-label="Item">
                  <Link to={`/inventory/${row.item_id}`} className="item-name">
                    {row.name}
                  </Link>
                  <span className="sku">{row.sku}</span>
                </td>
                <td data-label="Movement">
                  <span className={`movement-type ${row.type}`}>
                    <Icon size={16} />
                    {row.type === 'in'
                      ? 'Stock in'
                      : row.type === 'out'
                        ? 'Stock out'
                        : 'Adjustment'}
                  </span>
                </td>
                <td
                  data-label="Quantity"
                  className={`quantity-change ${row.delta > 0 ? 'positive' : 'negative'}`}
                >
                  {row.delta > 0 ? '+' : ''}
                  {format.number(row.delta)}
                </td>
                {!compact && (
                  <>
                    <td data-label="Reason">
                      <span>{row.reason}</span>
                      {row.note && <small className="block muted">{row.note}</small>}
                    </td>
                    <td data-label="Recorded by">{row.actor}</td>
                  </>
                )}
                <td data-label="Date & time" className="muted date-cell">
                  {format.date(row.created_at)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
