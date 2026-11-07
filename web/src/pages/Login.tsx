import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
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

  return (
    <div className="login">
      <h1>수능 방송 스케줄러</h1>
      <p className="muted">타종·안내 방송을 시간표에 맞춰 자동으로 송출합니다.</p>

      {firebaseEnabled && (
        <div className="card">
          <h2>시험장 담당 교사 로그인</h2>
          <button className="primary big google" onClick={() => void google()} disabled={busy}>
            {busy ? '로그인 중…' : 'Google 계정으로 로그인'}
          </button>
          <ol className="steps muted">
            <li>본인 구글 계정으로 로그인합니다 (개인 계정·학교 계정 모두 가능).</li>
            <li>처음 한 번 학교를 골라 사용 신청을 하면 교육지원청이 승인합니다.</li>
            <li>승인 후에는 이 PC에서 로그인이 유지되어 바로 방송 화면이 열립니다.</li>
          </ol>
          {err && <p className="error">{err}</p>}

          <details className="admin-login">
            <summary className="muted">관리자·테스트 계정</summary>
            <form onSubmit={submit}>
              <label>
                계정 (이메일 또는 테스트 학교 코드)
                <input value={id} onChange={(e) => setId(e.target.value)} autoComplete="username" required />
              </label>
              <label>
                비밀번호
                <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" required />
              </label>
              <button disabled={busy}>로그인</button>
            </form>
          </details>
        </div>
      )}

      <div className="card">
        <h2>로컬 모드 {firebaseEnabled && <small className="muted">(서버 보고 없이 재생만)</small>}</h2>
        <SituationPicker value={localTemplate} onChange={setLocalTemplate} />
        <button className="big" onClick={local}>
          로컬 모드로 시작
        </button>
      </div>
    </div>
  );
}
