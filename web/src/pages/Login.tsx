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

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await s.login(id, pw);
      nav('/', { replace: true });
    } catch {
      setErr('학교 코드 또는 비밀번호가 올바르지 않습니다.');
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
        <form className="card" onSubmit={submit}>
          <h2>시험장 로그인</h2>
          <label>
            나이스 학교코드
            <input value={id} onChange={(e) => setId(e.target.value)} inputMode="numeric" autoFocus required />
          </label>
          <label>
            비밀번호
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} required />
          </label>
          {err && <p className="error">{err}</p>}
          <button className="primary big" disabled={busy}>
            {busy ? '로그인 중…' : '로그인'}
          </button>
        </form>
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
