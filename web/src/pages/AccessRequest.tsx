import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  loadDirectory,
  neisCodeError,
  schoolLabel,
  submitRequest,
  watchMyRequest,
  type AccessRequest as Req,
  type DirectorySchool,
} from '../core/access';
import { useSession } from '../session';

/** 구글 로그인은 했지만 아직 학교 권한이 없는 담당 교사: 사용 신청 → 승인 대기 */
export default function AccessRequest() {
  const s = useSession();
  const nav = useNavigate();
  const user = s.user!;
  const [schools, setSchools] = useState<DirectorySchool[]>([]);
  const [req, setReq] = useState<Req | null | undefined>(undefined);
  const [schoolId, setSchoolId] = useState('');
  const [name, setName] = useState(user.displayName ?? '');
  const [phone, setPhone] = useState('');
  const [neis, setNeis] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    void loadDirectory().then(setSchools);
    return watchMyRequest(user.uid, setReq);
  }, [user.uid]);

  // 승인되면 새 권한을 받아 바로 방송 화면으로
  useEffect(() => {
    if (req?.status !== 'approved') return;
    void s.refreshClaims().then(() => nav('/', { replace: true }));
  }, [req?.status]);

  useEffect(() => {
    if (!req) return;
    setSchoolId(req.schoolId);
    setName(req.name || user.displayName || '');
    setPhone(req.phone ?? '');
    setNeis(req.neisCode ?? '');
  }, [req?.schoolId, req?.status]);

  const neisErr = neisCodeError(neis);
  const school = schools.find((x) => x.id === (req?.schoolId ?? schoolId));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!schoolId || !name.trim() || neisErr) return;
    setBusy(true);
    setErr('');
    try {
      await submitRequest({
        uid: user.uid,
        email: user.email ?? '',
        displayName: user.displayName ?? '',
        name: name.trim(),
        phone: phone.trim(),
        schoolId,
        neisCode: neis.trim(),
      });
      setEditing(false);
    } catch (e2) {
      setErr(`신청을 저장하지 못했습니다. (${(e2 as Error).message})`);
    } finally {
      setBusy(false);
    }
  }

  const showForm = req === null || editing || req?.status === 'rejected' || req?.status === 'revoked';

  return (
    <div className="login">
      <h1>시험장 사용 신청</h1>
      <p className="muted">
        {user.email} 로 로그인됨 ·{' '}
        <button className="link" onClick={() => void s.logout()}>
          다른 계정으로 로그인
        </button>
      </p>

      {req === undefined && <div className="card muted">신청 상태 확인 중…</div>}

      {req && req.status === 'pending' && !editing && (
        <div className="card wait">
          <h2>⏳ 교육지원청 승인 대기 중</h2>
          <dl className="kv">
            <dt>시험장</dt>
            <dd>{school ? schoolLabel(school) : req.schoolId}</dd>
            <dt>담당 교사</dt>
            <dd>
              {req.name}
              {req.phone && ` · ${req.phone}`}
            </dd>
            {req.requestedAt && (
              <>
                <dt>신청 시각</dt>
                <dd>{new Date(req.requestedAt.toMillis()).toLocaleString('ko-KR')}</dd>
              </>
            )}
          </dl>
          <p className="muted">승인되면 이 화면이 자동으로 방송 화면으로 바뀝니다. 창을 닫았다가 다시 열어도 됩니다.</p>
          <button className="small" onClick={() => setEditing(true)}>
            신청 내용 고치기
          </button>
        </div>
      )}

      {req?.status === 'rejected' && (
        <div className="banner bad">
          신청이 반려되었습니다{req.reason ? `: ${req.reason}` : '.'} 내용을 고쳐 다시 신청하세요.
        </div>
      )}
      {req?.status === 'revoked' && (
        <div className="banner bad">
          이 계정의 시험장 권한이 회수되었습니다{req.reason ? `: ${req.reason}` : '.'} 필요하면 다시 신청하세요.
        </div>
      )}

      {showForm && (
        <form className="card" onSubmit={submit}>
          <h2>신청서</h2>
          <label>
            시험장 (학교)
            <select value={schoolId} onChange={(e) => setSchoolId(e.target.value)} required>
              <option value="">— 학교를 고르세요 —</option>
              {schools.map((x) => (
                <option key={x.id} value={x.id}>
                  {schoolLabel(x)}
                  {x.special ? ' (별도 운영 시험장)' : ''}
                </option>
              ))}
            </select>
          </label>
          {schools.length === 0 && <p className="error">학교 목록을 불러오지 못했습니다. 인터넷 연결을 확인하세요.</p>}
          <label>
            담당 교사 이름
            <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} />
          </label>
          <label>
            연락처 <small className="muted">(선택 — 승인 확인 전화용)</small>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" maxLength={20} />
          </label>
          <label>
            나이스 학교코드 <small className="muted">(선택 — 추후 자동 확인용, 지금은 비워도 됩니다)</small>
            <input value={neis} onChange={(e) => setNeis(e.target.value)} inputMode="numeric" maxLength={7} placeholder="예: 7010000" />
          </label>
          {neisErr && <p className="error">{neisErr}</p>}
          {err && <p className="error">{err}</p>}
          <div className="row">
            <button className="primary big" disabled={busy || !schoolId || !name.trim() || !!neisErr}>
              {busy ? '저장 중…' : req ? '다시 신청' : '사용 신청'}
            </button>
            {editing && (
              <button type="button" onClick={() => setEditing(false)}>
                취소
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
