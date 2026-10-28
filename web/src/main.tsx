import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';
import { SessionProvider, useSession } from './session';
import Login from './pages/Login';
import Player from './pages/Player';
import StatusBoard from './pages/StatusBoard';
import './styles.css';

registerSW({ immediate: true });

function Guard({ children, admin = false }: { children: JSX.Element; admin?: boolean }) {
  const s = useSession();
  if (s.loading) return <div className="center muted">불러오는 중…</div>;
  if (!s.neisCode && !s.user) return <Navigate to="/login" replace />;
  if (admin && !s.isAdmin) return <Navigate to="/player" replace />;
  return children;
}

function Home() {
  const s = useSession();
  if (s.loading) return <div className="center muted">불러오는 중…</div>;
  if (s.isAdmin) return <Navigate to="/admin/status" replace />;
  return <Navigate to={s.neisCode ? '/player' : '/login'} replace />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SessionProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/player" element={<Guard><Player /></Guard>} />
          <Route path="/admin/status" element={<Guard admin><StatusBoard /></Guard>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </SessionProvider>
  </StrictMode>,
);
