/**
 * 화면 테마 — StudentHub와 같은 틀(MUI·Pretendard·테두리 카드)에 수능 방송용 남색·파랑 계열.
 * FHD(1920×1080) 기준으로만 맞춘다 (글자 크기 고정 16px).
 *
 * MUI 컴포넌트(메뉴·상단바)와 직접 쓴 CSS(styles.css의 --변수)가 같은 색을 쓰도록
 * <html data-theme="light|dark">를 함께 바꾼다.
 */
import CssBaseline from '@mui/material/CssBaseline';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ColorMode = 'light' | 'dark';

const PALETTE = {
  light: {
    mode: 'light' as const,
    primary: { main: '#1e3a8a', light: '#3b5bdb', dark: '#172554', contrastText: '#fff' },
    secondary: { main: '#2563eb' },
    success: { main: '#16a34a' },
    warning: { main: '#d97706' },
    error: { main: '#dc2626' },
    background: { default: '#f3f5f9', paper: '#ffffff' },
    divider: '#e2e8f0',
    text: { primary: '#0f172a', secondary: '#5b6b82' },
  },
  dark: {
    mode: 'dark' as const,
    primary: { main: '#8fb0ff', light: '#b6cbff', dark: '#5b7fd6', contrastText: '#0b1630' },
    secondary: { main: '#60a5fa' },
    success: { main: '#22c55e' },
    warning: { main: '#f59e0b' },
    error: { main: '#f87171' },
    // 남색 바탕 — 시험 당일 오래 켜 둬도 눈이 덜 피곤하게
    background: { default: '#0f1b2d', paper: '#16263d' },
    divider: '#2a3f5f',
    text: { primary: '#eef3fa', secondary: '#9fb1c9' },
  },
};

export function createAppTheme(mode: ColorMode) {
  return createTheme({
    palette: PALETTE[mode],
    spacing: (f: number) => `${0.5 * f}rem`,
    shape: { borderRadius: 10 },
    typography: {
      fontFamily: "'Pretendard Variable', Pretendard, 'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif",
      h5: { fontWeight: 800, letterSpacing: '-0.015em' },
      h6: { fontWeight: 700 },
      button: { fontWeight: 600, textTransform: 'none' },
    },
    components: {
      MuiPaper: { defaultProps: { elevation: 0 }, styleOverrides: { root: { backgroundImage: 'none' } } },
      MuiButton: { defaultProps: { disableElevation: true } },
      MuiChip: { styleOverrides: { root: { fontWeight: 600 } } },
      // 직접 쓴 CSS(styles.css)의 body 배경·글꼴을 그대로 두도록 CssBaseline은 최소한만
      MuiCssBaseline: { styleOverrides: { body: { backgroundColor: 'var(--bg)' } } },
    },
  });
}

const KEY = 'csat-cast:color-mode';
const Ctx = createContext<{ mode: ColorMode; toggle(): void }>({ mode: 'light', toggle: () => {} });

function readMode(): ColorMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    /* 저장소를 못 쓰면 OS 설정을 따른다 */
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function AppThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ColorMode>(readMode);
  useEffect(() => {
    document.documentElement.dataset.theme = mode;
  }, [mode]);
  const value = useMemo(
    () => ({
      mode,
      toggle: () =>
        setMode((m) => {
          const next = m === 'dark' ? 'light' : 'dark';
          try {
            localStorage.setItem(KEY, next);
          } catch {
            /* 저장 못 해도 이번 화면에는 적용 */
          }
          return next;
        }),
    }),
    [mode],
  );
  const theme = useMemo(() => createAppTheme(mode), [mode]);
  return (
    <Ctx.Provider value={value}>
      <ThemeProvider theme={theme}>
        <CssBaseline enableColorScheme />
        {children}
      </ThemeProvider>
    </Ctx.Provider>
  );
}

export const useColorMode = () => useContext(Ctx);
