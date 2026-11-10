import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { api, jsonBody, refreshSession, setToken } from './api';
import type { Brand, User } from '../shared/contracts';
import { ForcedPasswordChange } from './components/ForcedPasswordChange';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15000, retry: 1, refetchOnWindowFocus: true } },
});
// The server adds mustChangePassword for accounts an Admin created with a temporary password.
type SessionUser = User & { mustChangePassword?: boolean };
interface AuthState {
  user: SessionUser | null;
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
}
const AuthContext = createContext<AuthState>(null!);
export const useAuth = () => useContext(AuthContext);
export const useBrand = () =>
  useQuery({
    queryKey: ['brand'],
    queryFn: ({ signal }) => api<Brand>('/settings/branding', { signal }),
    staleTime: 60000,
    refetchInterval: 60000,
  });
export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}
function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const clear = useCallback(() => {
    setToken(null);
    setUser(null);
    queryClient.clear();
  }, []);
  useEffect(() => {
    let active = true;
    refreshSession()
      .then((data) => {
        if (active) setUser(data.user);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    const expired = () => clear();
    const broadcast = new BroadcastChannel('sdp-auth');
    broadcast.onmessage = (event) => {
      if (event.data === 'logout') clear();
    };
    window.addEventListener('sdp-session-expired', expired);
    return () => {
      active = false;
      broadcast.close();
      window.removeEventListener('sdp-session-expired', expired);
    };
  }, [clear]);
  const login = async (email: string, password: string) => {
    const data = await api<{ token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: jsonBody({ email, password }),
    });
    queryClient.clear();
    setToken(data.token);
    setUser(data.user);
  };
  const logout = async () => {
    await api('/auth/logout', { method: 'POST' });
    clear();
    const channel = new BroadcastChannel('sdp-auth');
    channel.postMessage('logout');
    channel.close();
  };
  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {user?.mustChangePassword ? (
        <ForcedPasswordChange onSignOut={() => logout().catch(clear)} onDone={clear} />
      ) : (
        children
      )}
    </AuthContext.Provider>
  );
}
export function useFormat() {
  const { data: brand } = useBrand();
  return {
    number: (value: number | string) => new Intl.NumberFormat('en').format(Number(value)),
    date: (value: string) =>
      new Intl.DateTimeFormat('en', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: brand?.timezone || 'Asia/Shanghai',
      }).format(new Date(value)),
  };
}