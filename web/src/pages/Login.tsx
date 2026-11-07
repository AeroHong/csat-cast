import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import GoogleIcon from '@mui/icons-material/Google';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, Paper, Stack, TextField, Typography } from '@mui/material';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import AuthLayout from '../components/AuthLayout';
import { DEFAULT_TEMPLATE_ID, saveLocalProfile, defaultProfile } from '../core/catalog';
import { firebaseEnabled } from '../core/firebase';
import { useSession } from '../session';
import SituationPicker from './SituationPicker';

export default function Login() {
  const s = useSession();
  const nav = useNavigate();
  const [id, setId] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [localTemplate, setLocalTemplate] = useState(DEFAULT_TEMPLATE_ID);

  async function google() {
    setErr('');
    setBusy(true);
    try {
      await s.loginWithGoogle();
      nav('/', { replace: true });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'auth/popup-closed-by-user' && code !== 'auth/cancelled-popup-request')
        setErr(`구글 로그인에 실패했습니다. (${code ?? (e as Error).message})`);
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await s.login(id, pw);
      nav('/', { replace: true });
    } catch {
      setErr('계정 또는 비밀번호가 올바르지 않습니다.');
    } finally {
      setBusy(false);
    }
  }

  function local() {
    saveLocalProfile(defaultProfile('LOCAL', localTemplate));
    s.enterLocalMode();
    nav('/player', { replace: true });
  }

  const localCard = (
    <Paper variant="outlined" sx={{ p: 3.5 }}>
      <Stack spacing={2}>
        <Box>
          <Typography variant="h6">로컬 모드</Typography>
          <Typography variant="body2" color="text.secondary">
            {firebaseEnabled ? '서버 보고 없이 이 PC에서 재생만 합니다.' : '이 PC에서 시간표대로 재생합니다.'}
          </Typography>
        </Box>
        <SituationPicker value={localTemplate} onChange={setLocalTemplate} />
        <Button variant="outlined" size="large" onClick={local}>
          로컬 모드로 시작
        </Button>
      </Stack>
    </Paper>
  );

  return (
    <AuthLayout title="수능 방송 스케줄러" subtitle="타종·안내 방송을 시간표에 맞춰 자동으로 송출합니다." width={firebaseEnabled ? 1040 : 520}>
      {firebaseEnabled ? (
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3, alignItems: 'start' }}>
          <Paper variant="outlined" sx={{ p: 3.5 }}>
            <Stack spacing={2.5}>
              <Typography variant="h6">시험장 담당 교사 로그인</Typography>
              <Button variant="contained" size="large" startIcon={<GoogleIcon />} onClick={() => void google()} disabled={busy} sx={{ py: 1.5 }}>
                {busy ? '로그인 중…' : 'Google 계정으로 로그인'}
              </Button>
              <Box component="ol" sx={{ m: 0, pl: 2.5, color: 'text.secondary', lineHeight: 1.8, fontSize: '0.92rem' }}>
                <li>본인 구글 계정으로 로그인합니다 (개인 계정·학교 계정 모두 가능).</li>
                <li>처음 한 번 학교를 골라 사용 신청을 하면 교육지원청이 승인합니다.</li>
                <li>승인 후에는 이 PC에서 로그인이 유지되어 바로 방송 화면이 열립니다.</li>
              </Box>
              {err && <Alert severity="error">{err}</Alert>}

              <Accordion disableGutters variant="outlined" sx={{ '&:before': { display: 'none' }, borderRadius: 2 }}>
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                  <Typography variant="body2" color="text.secondary">
                    관리자·테스트 계정
                  </Typography>
                </AccordionSummary>
                <AccordionDetails>
                  <Stack component="form" spacing={1.5} onSubmit={submit}>
                    <TextField
                      size="small"
                      label="계정 (이메일 또는 테스트 학교 코드)"
                      value={id}
                      onChange={(e) => setId(e.target.value)}
                      autoComplete="username"
                      required
                    />
                    <TextField
                      size="small"
                      type="password"
                      label="비밀번호"
                      value={pw}
                      onChange={(e) => setPw(e.target.value)}
                      autoComplete="current-password"
                      required
                    />
                    <Button type="submit" variant="outlined" disabled={busy}>
                      로그인
                    </Button>
                  </Stack>
                </AccordionDetails>
              </Accordion>
            </Stack>
          </Paper>
          {localCard}
        </Box>
      ) : (
        localCard
      )}
    </AuthLayout>
  );
}
