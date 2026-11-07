/**
 * 화면 틀 (StudentHub와 같은 구성): 왼쪽 메뉴 + 위쪽 상단바 + 본문.
 * FHD 기준 — 메뉴는 항상 펼쳐 두고, 필요하면 아이콘만 남기고 접는다.
 */
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import DarkModeIcon from '@mui/icons-material/DarkModeOutlined';
import LightModeIcon from '@mui/icons-material/LightModeOutlined';
import {
  AppBar,
  Avatar,
  Box,
  Chip,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material';
import { useState, type ReactNode } from 'react';
import { useColorMode } from '../theme';

export interface NavItem<K extends string = string> {
  key: K;
  label: string;
  icon: ReactNode;
  /** 메뉴 오른쪽 작은 표시 (건수·상태) */
  badge?: { label: string | number; color?: 'default' | 'error' | 'warning' | 'success' | 'primary' };
  disabled?: boolean;
}

const OPEN_W = '15rem';
const MINI_W = '4.25rem';
const COLLAPSE_KEY = 'csat-cast:nav-collapsed';

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

export default function AppShell<K extends string>({
  subtitle,
  nav,
  active,
  onSelect,
  title,
  status,
  right,
  operator,
  email,
  onLogout,
  logoutDisabled,
  logoutHint,
  fill = false,
  children,
}: {
  /** 로고 아래 작은 글씨 (시험지구·시험장 이름) */
  subtitle?: ReactNode;
  nav: NavItem<K>[];
  active: K;
  onSelect(key: K): void;
  /** 상단바 왼쪽 제목 (없으면 선택한 메뉴 이름) */
  title?: ReactNode;
  /** 제목 옆 상태 표시 */
  status?: ReactNode;
  /** 상단바 오른쪽 (시계 등) */
  right?: ReactNode;
  operator?: string;
  email?: string | null;
  onLogout(): void;
  logoutDisabled?: boolean;
  logoutHint?: string;
  /** 본문을 화면 높이에 고정 (안에서 열마다 따로 스크롤하는 화면) */
  fill?: boolean;
  children: ReactNode;
}) {
  const { mode, toggle } = useColorMode();
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [userMenu, setUserMenu] = useState<HTMLElement | null>(null);
  const width = collapsed ? MINI_W : OPEN_W;
  const current = nav.find((n) => n.key === active);

  const toggleCollapsed = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? '0' : '1');
      } catch {
        /* 저장 못 해도 이번 화면에는 적용 */
      }
      return !c;
    });

  return (
    <Box sx={{ display: 'flex', height: '100vh', bgcolor: 'background.default' }}>
      <Drawer
        variant="permanent"
        sx={{
          width,
          flexShrink: 0,
          transition: 'width .15s',
          '& .MuiDrawer-paper': { width, boxSizing: 'border-box', overflowX: 'hidden', transition: 'width .15s', borderColor: 'divider' },
        }}
      >
        <Box sx={{ px: collapsed ? 1.5 : 2.5, py: 2.25, minHeight: '4.5rem' }}>
          <Typography variant="h6" sx={{ fontWeight: 900, letterSpacing: '-0.03em', lineHeight: 1.1, whiteSpace: 'nowrap' }}>
            {collapsed ? (
              <Box component="span" sx={{ color: 'primary.main' }}>
                CS
              </Box>
            ) : (
              <>
                CSAT
                <Box component="span" sx={{ color: 'primary.main' }}>
                  Cast
                </Box>
              </>
            )}
          </Typography>
          {!collapsed && (
            <Typography variant="caption" color="text.secondary" component="div" noWrap>
              {subtitle ?? '수능 안내방송'}
            </Typography>
          )}
        </Box>
        <List dense sx={{ px: 1, flex: 1 }}>
          {nav.map((n) => {
            const item = (
              <ListItemButton
                key={n.key}
                selected={n.key === active}
                disabled={n.disabled}
                onClick={() => onSelect(n.key)}
                sx={{ borderRadius: 2, mb: 0.5, py: 1, justifyContent: collapsed ? 'center' : 'flex-start' }}
              >
                <ListItemIcon sx={{ minWidth: collapsed ? 0 : '2.2rem', color: n.key === active ? 'primary.main' : undefined }}>
                  {n.icon}
                </ListItemIcon>
                {!collapsed && (
                  <>
                    <ListItemText primary={n.label} primaryTypographyProps={{ fontWeight: 700, noWrap: true }} />
                    {n.badge && <Chip size="small" label={n.badge.label} color={n.badge.color ?? 'default'} sx={{ height: 20, ml: 1 }} />}
                  </>
                )}
              </ListItemButton>
            );
            return collapsed ? (
              <Tooltip key={n.key} title={n.badge ? `${n.label} (${n.badge.label})` : n.label} placement="right">
                <span>{item}</span>
              </Tooltip>
            ) : (
              item
            );
          })}
        </List>
        <Divider />
        <Box sx={{ display: 'flex', justifyContent: collapsed ? 'center' : 'flex-end', p: 1 }}>
          <Tooltip title={collapsed ? '메뉴 펼치기' : '메뉴 접기'} placement="right">
            <IconButton size="small" onClick={toggleCollapsed}>
              {collapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
            </IconButton>
          </Tooltip>
        </Box>
      </Drawer>

      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
        <AppBar position="static" color="inherit" elevation={0} sx={{ borderBottom: 1, borderColor: 'divider', bgcolor: 'background.paper' }}>
          <Toolbar sx={{ gap: 1.5, minHeight: '3.75rem !important' }}>
            <Typography variant="h6" component="h1" noWrap sx={{ fontWeight: 800 }}>
              {title ?? current?.label}
            </Typography>
            {status && <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>{status}</Box>}
            <Box sx={{ flex: 1 }} />
            {right}
            <Tooltip title={mode === 'dark' ? '밝은 화면' : '어두운 화면'}>
              <IconButton onClick={toggle}>{mode === 'dark' ? <LightModeIcon /> : <DarkModeIcon />}</IconButton>
            </Tooltip>
            <Tooltip title={operator ?? ''}>
              <IconButton onClick={(e) => setUserMenu(e.currentTarget)}>
                <Avatar sx={{ width: '2rem', height: '2rem', bgcolor: 'primary.main', fontSize: '0.95rem' }}>{operator?.[0] ?? '?'}</Avatar>
              </IconButton>
            </Tooltip>
            <Menu anchorEl={userMenu} open={!!userMenu} onClose={() => setUserMenu(null)}>
              <Box sx={{ px: 2, py: 1 }}>
                <Typography fontWeight={700}>{operator}</Typography>
                {email && (
                  <Typography variant="caption" color="text.secondary">
                    {email}
                  </Typography>
                )}
              </Box>
              <Divider />
              <MenuItem
                disabled={logoutDisabled}
                onClick={() => {
                  setUserMenu(null);
                  onLogout();
                }}
              >
                로그아웃
              </MenuItem>
              {logoutDisabled && logoutHint && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 2, pb: 1, maxWidth: 260 }}>
                  {logoutHint}
                </Typography>
              )}
            </Menu>
          </Toolbar>
        </AppBar>
        <Box
          component="main"
          sx={
            fill
              ? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', px: 3, pt: 1.5, pb: 1.5 }
              : { flex: 1, minHeight: 0, overflow: 'auto', px: 3, pt: 2.5, pb: 5 }
          }
        >
          {children}
        </Box>
      </Box>
    </Box>
  );
}
