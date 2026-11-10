import { Component, lazy, Suspense, type ReactNode } from 'react';
import {
  createBrowserRouter,
  Navigate,
  Outlet,
  RouterProvider,
  useRouteError,
} from 'react-router-dom';
import { useAuth } from './context';
import { BrandMetadata } from './components/Brand';
import { Layout } from './components/Layout';
import { Button, ErrorBanner, Skeleton, ToastProvider } from './components/ui';
import { Page } from './components/Page';
import { AuthPage } from './pages/Auth';
const DashboardPage = lazy(() =>
  import('./pages/Dashboard').then((module) => ({ default: module.DashboardPage })),
);
const InventoryPage = lazy(() =>
  import('./pages/Inventory').then((module) => ({ default: module.InventoryPage })),
);
const ItemEditorPage = lazy(() =>
  import('./pages/ItemEditor').then((module) => ({ default: module.ItemEditorPage })),
);
const ItemDetailPage = lazy(() =>
  import('./pages/ItemDetail').then((module) => ({ default: module.ItemDetailPage })),
);
const AlertsPage = lazy(() =>
  import('./pages/Records').then((module) => ({ default: module.AlertsPage })),
);
const AuditPage = lazy(() =>
  import('./pages/Records').then((module) => ({ default: module.AuditPage })),
);
const MovementsPage = lazy(() =>
  import('./pages/Records').then((module) => ({ default: module.MovementsPage })),
);
const SettingsPage = lazy(() =>
  import('./pages/Settings').then((module) => ({ default: module.SettingsPage })),
);
const UsersPage = lazy(() =>
  import('./pages/Users').then((module) => ({ default: module.UsersPage })),
);
const RequestsPage = lazy(() =>
  import('./pages/Requests').then((module) => ({ default: module.RequestsPage })),
);
const deferred = (page: ReactNode) => <Suspense fallback={<Skeleton rows={5} />}>{page}</Suspense>;

function Protected({
  admin = false,
  editor = false,
  operations = false,
}: {
  admin?: boolean;
  editor?: boolean;
  operations?: boolean;
}) {
  const { user, loading } = useAuth();
  if (loading)
    return (
      <div className="session-loading">
        <Skeleton rows={3} />
      </div>
    );
  if (!user) return <Navigate to="/login" replace />;
  if (admin && user.role !== 'Admin')
    return (
      <Page title="Access restricted">
        <ErrorBanner message="Only an Admin can open this page." />
      </Page>
    );
  if (
    (editor && !['Admin', 'Manager'].includes(user.role)) ||
    (operations && user.role === 'Staff')
  )
    return (
      <Page title="Access restricted">
        <ErrorBanner message="Your role cannot open this page. Browse the tool catalog or view your own requests." />
        <LinkToRequests />
      </Page>
    );
  return <Outlet />;
}
function LinkToRequests() {
  return (
    <a className="button neutral outline" href="/requests">
      My requests
    </a>
  );
}
function LandingPage() {
  const { user } = useAuth();
  return user?.role === 'Staff' ? <Navigate to="/requests" replace /> : deferred(<DashboardPage />);
}
function RouteError() {
  const error = useRouteError();
  return (
    <div className="main-content">
      <Page title="Unable to open this page">
        <ErrorBanner
          message={error instanceof Error ? error.message : 'This page is not available.'}
        />
        <Button onClick={() => window.location.assign('/')}>Return to Dashboard</Button>
      </Page>
    </div>
  );
}
const router = createBrowserRouter([
  {
    element: (
      <>
        <BrandMetadata />
        <Outlet />
      </>
    ),
    errorElement: <RouteError />,
    children: [
      ...['login', 'forgot-password', 'reset-password', 'activate'].map((path) => ({
        path,
        element: <AuthPage key={path} />,
      })),
      {
        element: <Protected />,
        children: [
          {
            element: <Layout />,
            children: [
              { index: true, element: <LandingPage /> },
              { path: 'requests', element: deferred(<RequestsPage />) },
              { path: 'inventory', element: deferred(<InventoryPage />) },
              {
                element: <Protected editor />,
                children: [
                  { path: 'inventory/new', element: deferred(<ItemEditorPage key="new" />) },
                  { path: 'inventory/:id/edit', element: deferred(<ItemEditorPage />) },
                ],
              },
              { path: 'inventory/:id', element: deferred(<ItemDetailPage />) },
              {
                element: <Protected operations />,
                children: [
                  { path: 'movements', element: deferred(<MovementsPage />) },
                  { path: 'alerts', element: deferred(<AlertsPage />) },
                ],
              },
              {
                element: <Protected admin />,
                children: [
                  { path: 'users', element: deferred(<UsersPage />) },
                  { path: 'audit', element: deferred(<AuditPage />) },
                  { path: 'settings', element: deferred(<SettingsPage />) },
                ],
              },
              {
                path: '*',
                element: (
                  <Page title="Page not found">
                    <p>The requested page does not exist.</p>
                    <a className="button primary solid" href="/">
                      Dashboard
                    </a>
                  </Page>
                ),
              },
            ],
          },
        ],
      },
    ],
  },
]);
class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <div className="main-content">
          <h1>SDP Inventory</h1>
          <ErrorBanner message="The page could not be displayed. Reload to try again." />
          <Button onClick={() => window.location.reload()}>Reload</Button>
        </div>
      );
    return this.props.children;
  }
}
export function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </ErrorBoundary>
  );
}
