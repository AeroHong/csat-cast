/** 로그인·사용 신청 화면 틀: 가운데 정렬, 위에 로고와 화면 전환 버튼 (AppShell과 같은 색·글꼴) */
import DarkModeIcon from '@mui/icons-material/DarkModeOutlined';
import LightModeIcon from '@mui/icons-material/LightModeOutlined';
import { Box, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import type { ReactNode } from 'react';
import { useColorMode } from '../theme';

export default function AuthLayout({
  title,
  subtitle,
  width = 460,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  width?: number;
  children: ReactNode;
}) {
  const { mode, toggle } = useColorMode();
  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', px: 4, py: 2.5 }}>
        <Typography variant="h6" sx={{ fontWeight: 900, letterSpacing: '-0.03em' }}>
          CSAT
          <Box component="span" sx={{ color: 'primary.main' }}>
            Cast
          </Box>
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ ml: 1.5 }}>
          수능 안내방송
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Tooltip title={mode === 'dark' ? '밝은 화면' : '어두운 화면'}>
          <IconButton onClick={toggle}>{mode === 'dark' ? <LightModeIcon /> : <DarkModeIcon />}</IconButton>
        </Tooltip>
      </Box>
      <Box sx={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', pt: '8vh', pb: 6, px: 3 }}>
        <Stack spacing={3} sx={{ width, maxWidth: '100%' }}>
          <Box>
            <Typography variant="h4" component="h1" sx={{ fontWeight: 800, letterSpacing: '-0.02em' }}>
              {title}
            </Typography>
            {subtitle && (
              <Typography color="text.secondary" sx={{ mt: 1 }}>
                {subtitle}
              </Typography>
            )}
          </Box>
          {children}
        </Stack>
      </Box>
    </Box>
  );
}
