import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { initUpdates } from './core/updates';
import { SessionProvider, useSession } from './session';
import AccessRequest from './pages/AccessRequest';
import Login from './pages/Login';
import Player from './pages/Player';
import StatusBoard from './pages/StatusBoard';
import './styles.css';
import { AppThemeProvider } from './theme';

initUpdates();

function Guard({ children, admin = false }: { children: JSX.Element; admin?: boolean }) {
  const s = useSession();
  if (s.loading) return <div className="center muted">불러오는 중…</div>;
  if (!s.neisCode && !s.user) return <Navigate to="/login" replace />;
  // 구글 로그인은 했지만 아직 승인 전이면 사용 신청 화면으로
  if (s.pendingApproval) return <Navigate to="/request" replace />;
  if (!admin && !s.neisCode) return <Navigate to="/" replace />;
  if (admin && !s.isAdmin) return <Navigate to="/player" replace />;
  return children;
}

function Home() {
  const s = useSession();
  if (s.loading) return <div className="center muted">불러오는 중…</div>;
  if (s.isAdmin) return <Navigate to="/admin/status" replace />;
  if (s.pendingApproval) return <Navigate to="/request" replace />;
  return <Navigate to={s.neisCode ? '/player' : '/login'} replace />;
}

function RequestGuard() {
  const s = useSession();
  if (s.loading) return <div className="center muted">불러오는 중…</div>;
  if (!s.user) return <Navigate to="/login" replace />;
  if (!s.pendingApproval) return <Navigate to="/" replace />;
  return <AccessRequest />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppThemeProvider>
    <SessionProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/request" element={<RequestGuard />} />
          <Route path="/player" element={<Guard><Player /></Guard>} />
          <Route path="/admin/status" element={<Guard admin><StatusBoard /></Guard>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </SessionProvider>
    </AppThemeProvider>
  </StrictMode>,
);
