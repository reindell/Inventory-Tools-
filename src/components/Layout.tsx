import { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  Archive,
  ArrowLeftRight,
  Bell,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Settings,
  ShieldCheck,
  Sun,
  Users,
} from 'lucide-react';
import { useAuth, useBrand } from '../context';
import { Brand } from './Brand';
import { Button, Dialog, ErrorBanner } from './ui';
import { COMPANY_NAME } from '../../shared/contracts';
import { RequestNotifications } from './RequestNotifications';

export function Layout() {
  const { user, logout } = useAuth();
  const { data: brand } = useBrand();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState('');
  const [theme, setTheme] = useState(document.documentElement.dataset.theme || 'light');
  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('sdp-theme', next);
    setTheme(next);
  };
  const links = [
    ...(user?.role !== 'Staff' ? [{ path: '/', label: 'Dashboard', icon: LayoutDashboard }] : []),
    {
      path: '/requests',
      label: user?.role === 'Admin' ? 'Tool requests' : 'My requests',
      icon: ClipboardList,
    },
    {
      path: '/inventory',
      label: user?.role === 'Staff' ? 'Tool catalog' : 'Inventory',
      icon: Archive,
    },
    ...(user?.role !== 'Staff'
      ? [
          { path: '/movements', label: 'Stock movements', icon: ArrowLeftRight },
          { path: '/alerts', label: 'Low-stock alerts', icon: Bell },
        ]
      : []),
    ...(user?.role === 'Admin'
      ? [
          { path: '/users', label: 'Users & roles', icon: Users },
          { path: '/audit', label: 'Audit log', icon: ShieldCheck },
          { path: '/settings', label: 'Settings', icon: Settings },
        ]
      : []),
  ];
  const navigation = (mobile = false) => (
    <>
      <Link
        to="/"
        className="brand-link"
        aria-label={user?.role === 'Staff' ? 'SDP requests' : 'SDP Dashboard'}
        onClick={() => setMenu(false)}
      >
        <Brand compact={!mobile && collapsed} />
      </Link>
      <span className="nav-label">WORKSPACE</span>
      <nav aria-label={mobile ? 'Mobile navigation' : 'Main navigation'}>
        {links.map(({ path, label, icon: Icon }) => (
          <NavLink
            key={path}
            to={path}
            end={path === '/'}
            title={!mobile && collapsed ? label : undefined}
            onClick={() => setMenu(false)}
          >
            <Icon size={19} aria-hidden="true" />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <div className="production-card">
          <span className="status-dot" />
          <div>
            <strong>{brand?.locationName || 'Production'}</strong>
            <small>Single production location</small>
          </div>
        </div>
        <p className="sidebar-company">{brand?.companyName || COMPANY_NAME}</p>
        {!mobile && (
          <Button
            emphasis="ghost"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? (
              <ChevronRight size={18} />
            ) : (
              <>
                <ChevronLeft size={18} />
                Collapse sidebar
              </>
            )}
          </Button>
        )}
      </div>
    </>
  );
  return (
    <div className={`app-shell ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">{navigation()}</aside>
      <Dialog open={menu} title="Navigation" className="nav-dialog" onClose={() => setMenu(false)}>
        <div className="mobile-nav">{navigation(true)}</div>
      </Dialog>
      <div className="app-body">
        <header className="topbar">
          <div className="topbar-context">
            <Button
              className="mobile-menu"
              emphasis="ghost"
              aria-label="Open navigation"
              onClick={() => setMenu(true)}
            >
              <Menu size={21} />
            </Button>
            <span className="topbar-app">SDP Inventory</span>
            <span className="topbar-divider">/</span>
            <span className="production-label">
              <span className="status-dot" />
              {brand?.locationName || 'Production'}
            </span>
          </div>
          <div className="topbar-actions">
            <Button
              emphasis="ghost"
              aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
              onClick={toggleTheme}
            >
              {theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}
            </Button>
            <RequestNotifications />
            <span className="user-avatar" aria-hidden="true">
              {user?.name
                .split(' ')
                .map((v) => v[0])
                .slice(0, 2)
                .join('')}
            </span>
            <div className="user-info">
              <strong>{user?.name}</strong>
              <small>{user?.role}</small>
            </div>
            <Button
              emphasis="ghost"
              aria-label="Sign out"
              onClick={async () => {
                try {
                  await logout();
                  navigate('/login');
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              <LogOut size={18} />
            </Button>
          </div>
        </header>
        {error && (
          <div className="content-error">
            <ErrorBanner message={error} />
          </div>
        )}
        <main id="main-content" className="main-content" tabIndex={-1}>
          <Outlet />
        </main>
        <footer className="app-footer">
          <span>SDP Inventory</span>
          <span>One production. Every part accounted for.</span>
        </footer>
      </div>
    </div>
  );
}
