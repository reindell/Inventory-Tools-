import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import type { RequestNotification } from '../../shared/requests';
import { api } from '../api';
import { useFormat } from '../context';
import { Button, Dialog, EmptyState, ErrorBanner, Skeleton } from './ui';

export function RequestNotifications() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const client = useQueryClient();
  const format = useFormat();
  const query = useQuery({
    queryKey: ['notifications'],
    queryFn: ({ signal }) =>
      api<{ data: RequestNotification[]; unread: number }>('/notifications', { signal }),
    refetchInterval: 20000,
  });
  const read = async (id?: string) => {
    setBusy(true);
    setError('');
    try {
      await api(id ? `/notifications/${id}/read` : '/notifications/read-all', {
        method: id ? 'PATCH' : 'POST',
      });
      await client.invalidateQueries({ queryKey: ['notifications'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const unread = query.data?.unread || 0;
  return (
    <>
      <Button
        emphasis="ghost"
        className="request-notification-trigger"
        aria-label="Request notifications"
        aria-describedby="request-notification-count"
        onClick={() => setOpen(true)}
      >
        <Bell size={18} />
        {unread > 0 && (
          <span className="notification-count" aria-hidden="true">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </Button>
      <span id="request-notification-count" className="sr-only" role="status" aria-live="polite">
        {query.isError
          ? 'Request notifications are unavailable. Open to retry.'
          : query.isPending
            ? 'Checking request notifications.'
            : `${unread} unread request notifications`}
      </span>
      <Dialog
        open={open}
        title="Request notifications"
        description="Updates about tool and jig requests."
        onClose={() => setOpen(false)}
        busy={busy}
      >
        {error && <ErrorBanner message={error} />}
        {query.isPending ? (
          <Skeleton rows={3} />
        ) : query.isError ? (
          <ErrorBanner message={query.error.message} retry={() => void query.refetch()} />
        ) : !query.data?.data.length ? (
          <EmptyState
            title="No request updates yet"
            description="New requests and status changes will appear here."
          />
        ) : (
          <>
            <div className="notification-actions">
              <Button emphasis="ghost" disabled={!unread} busy={busy} onClick={() => void read()}>
                <CheckCheck size={16} />
                Mark all as read
              </Button>
            </div>
            <ul className="request-notifications">
              {query.data.data.map((notification) => (
                <li key={notification.id} className={notification.read_at ? '' : 'unread'}>
                  <strong>{notification.title}</strong>
                  <p>{notification.message}</p>
                  <small className="muted">{format.date(notification.created_at)}</small>
                  <div>
                    <Link
                      className="text-link"
                      to={`/requests?requestId=${notification.request_id}`}
                      onClick={() => {
                        setOpen(false);
                        if (!notification.read_at) void read(notification.id);
                      }}
                    >
                      View request
                    </Link>
                    {!notification.read_at && (
                      <Button
                        emphasis="ghost"
                        disabled={busy}
                        onClick={() => void read(notification.id)}
                      >
                        Mark as read
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Dialog>
    </>
  );
}
