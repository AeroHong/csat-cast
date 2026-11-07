import { collection, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import {
  approveAccess,
  rejectAccess,
  revokeAccess,
  schoolLabel,
  setSchoolSituation,
  type AccessRequest,
} from '../../core/access';
import { fb } from '../../core/firebase';
import { buildPlan, kstTime } from '../../core/scheduler';
import type { Cue, EndPeriod, InquiryRooms, SchoolProfile, Template } from '../../core/types';
import { END_PERIOD_LABEL, INQUIRY_ROOMS_LABEL, csatTemplateId } from '../../data/templates';
import type { ChannelRow } from './data';

interface Audit {
  id: string;
  at?: { toMillis(): number } | null;
  by: string;
  action: 'approve' | 'reject' | 'revoke' | 'situation';
  email?: string;
  schoolId?: string;
  schoolName?: string;
  reason?: string;
  before?: { inquiry?: string; end?: string | number; templateId?: string };
  after?: { inquiry?: string; end?: string | number; templateId?: string };
}

const ACTION_LABEL: Record<Audit['action'], string> = { approve: '승인', reject: '반려', revoke: '권한 회수', situation: '유형 변경' };

function useRequests(status: AccessRequest['status']) {
  const [list, setList] = useState<(AccessRequest & { id: string })[]>([]);
  useEffect(() => {
    if (!fb) return;
    return onSnapshot(query(collection(fb.db, 'accessRequests'), where('status', '==', status)), (s) =>
      setList(s.docs.map((d) => ({ ...(d.data() as AccessRequest), id: d.id }))),
    );
  }, [status]);
  return list;
}

function useAudit() {
  const [list, setList] = useState<Audit[]>([]);
  useEffect(() => {
    if (!fb) return;
    return onSnapshot(query(collection(fb.db, 'auditLogs'), orderBy('at', 'desc'), limit(100)), (s) =>
      setList(s.docs.map((d) => ({ ...(d.data() as Omit<Audit, 'id'>), id: d.id }))),
    );
  }, []);
  return list;
}

const when = (t?: { toMillis(): number } | null) => (t ? new Date(t.toMillis()).toLocaleString('ko-KR') : '');

/** 사용 신청 승인·권한 회수, 학교별 시험장 유형, 감사 기록 */
export default function AccessAdmin({ schools, rows, templates }: { schools: SchoolProfile[]; rows: ChannelRow[]; templates: Template[] }) {
  const pending = useRequests('pending');
  const approved = useRequests('approved');
  const audit = useAudit();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ level: 'ok' | 'bad'; text: string } | null>(null);
  const sorted = [...schools].sort((a, b) => (a.examNo ?? 999) - (b.examNo ?? 999) || a.name.localeCompare(b.name, 'ko'));
  const nameOf = (id: string) => {
    const s = schools.find((x) => x.neisCode === id);
    return s ? schoolLabel({ name: s.name, examNo: s.examNo ?? null }) : id;
  };

  async function run(key: string, fn: () => Promise<void>, ok: string) {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      setMsg({ level: 'ok', text: ok });
    } catch (e) {
      setMsg({ level: 'bad', text: `실패: ${(e as Error).message}` });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="admin-access">
      {msg && <div className={`banner ${msg.level === 'bad' ? 'bad' : 'okay'}`}>{msg.text}</div>}

      <section className="card">
        <h2>
          사용 신청 <span className="tag">{pending.length}</span>
        </h2>
        {pending.length === 0 ? (
          <p className="muted">대기 중인 신청이 없습니다.</p>
        ) : (
          <table className="list">
            <thead>
              <tr>
                <th>신청 시각</th>
                <th>담당 교사</th>
                <th>구글 계정</th>
                <th>시험장</th>
                <th>나이스 코드</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pending.map((r) => (
                <PendingRow key={r.id} r={r} schools={sorted} busy={busy === r.id} run={run} />
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">
          승인하면 그 계정에 해당 시험장 권한이 붙고, 신청자 화면이 자동으로 방송 화면으로 바뀝니다. 신청자와 전화 등으로 본인 확인 후 승인하세요.
        </p>
      </section>

      <section className="card">
        <h2>승인된 담당 교사</h2>
        {approved.length === 0 ? (
          <p className="muted">아직 없습니다.</p>
        ) : (
          <table className="list">
            <thead>
              <tr>
                <th>시험장</th>
                <th>담당 교사</th>
                <th>구글 계정</th>
                <th>승인</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {[...approved]
                .sort((a, b) => nameOf(a.schoolId).localeCompare(nameOf(b.schoolId), 'ko'))
                .map((r) => (
                  <tr key={r.id}>
                    <td>{nameOf(r.schoolId)}</td>
                    <td>
                      {r.name}
                      {r.phone && <span className="muted"> · {r.phone}</span>}
                    </td>
                    <td>{r.email}</td>
                    <td className="muted small">
                      {when(r.decidedAt)} · {r.decidedBy}
                    </td>
                    <td className="actions">
                      <button
                        className="small danger"
                        disabled={busy === r.id}
                        onClick={() => {
                          const live = rows.some((x) => x.code === r.schoolId && x.s?.armed && x.online);
                          const ask = live
                            ? `${nameOf(r.schoolId)}은(는) 지금 자동 방송 중입니다.
회수해도 방송은 그 PC에서 계속되지만, 서버 보고가 끊겨 현황판에서 확인할 수 없게 됩니다.
그래도 ${r.name}의 권한을 회수할까요?`
                            : `${r.name}(${r.email})의 ${nameOf(r.schoolId)} 권한을 회수할까요?`;
                          if (window.confirm(ask)) void run(r.id, () => revokeAccess({ uid: r.uid }), `${r.name} 권한을 회수했습니다.`);
                        }}
                      >
                        권한 회수
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
        <p className="muted small">권한을 회수하면 열려 있는 화면도 1시간 안에 끊깁니다. 담당자가 바뀌거나 PC를 분실했을 때 사용하세요.</p>
      </section>

      <section className="card">
        <h2>시험장 유형</h2>
        <p className="muted small">
          4교시 탐구 시험실과 종료 교시로 평가원 안내방송 유형(1~6)이 정해집니다. 자동 방송 중인 시험장은 바꿀 수 없고, 바꾼 내용은 학교 PC가 화면을 다시 열 때 반영됩니다(그 전까지는 현황판에 '서버 설정과 다름' 경고).
        </p>
        <table className="list">
          <thead>
            <tr>
              <th>시험장</th>
              <th>4교시 탐구 시험실</th>
              <th>종료 교시</th>
              <th>유형</th>
              <th>방송</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => (
              <SituationRow
                key={s.neisCode}
                s={s}
                armed={rows.some((r) => r.code === s.neisCode && r.s?.armed && r.online)}
                busy={busy === `sit-${s.neisCode}`}
                run={run}
                templates={templates}
              />
            ))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>감사 기록</h2>
        {audit.length === 0 ? (
          <p className="muted">기록이 없습니다.</p>
        ) : (
          <ul className="audit">
            {audit.map((a) => (
              <li key={a.id}>
                <span className="muted mono">{when(a.at)}</span> <strong>{ACTION_LABEL[a.action] ?? a.action}</strong>{' '}
                {a.schoolId && nameOf(a.schoolId)} {a.email && <span className="muted">{a.email}</span>}{' '}
                {a.action === 'situation' && a.before && a.after && (
                  <span>
                    {a.before.templateId} → {a.after.templateId}
                  </span>
                )}
                {a.reason && <span className="muted"> ({a.reason})</span>} <span className="muted small">by {a.by}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

type Run = (key: string, fn: () => Promise<void>, ok: string) => Promise<void>;

function PendingRow({ r, schools, busy, run }: { r: AccessRequest & { id: string }; schools: SchoolProfile[]; busy: boolean; run: Run }) {
  const [schoolId, setSchoolId] = useState(r.schoolId);
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  return (
    <tr>
      <td className="muted small">{when(r.requestedAt)}</td>
      <td>
        {r.name}
        {r.phone && <div className="muted small">{r.phone}</div>}
      </td>
      <td>
        {r.email}
        {r.displayName && r.displayName !== r.name && <div className="muted small">{r.displayName}</div>}
      </td>
      <td>
        <select value={schoolId} onChange={(e) => setSchoolId(e.target.value)}>
          {!schools.some((s) => s.neisCode === r.schoolId) && <option value={r.schoolId}>{r.schoolId} (미등록)</option>}
          {schools.map((s) => (
            <option key={s.neisCode} value={s.neisCode}>
              {schoolLabel({ name: s.name, examNo: s.examNo ?? null })}
            </option>
          ))}
        </select>
        {schoolId !== r.schoolId && <div className="muted small">신청: {r.schoolId}</div>}
      </td>
      <td className="mono small">{r.neisCode || <span className="muted">—</span>}</td>
      <td className="actions">
        {rejecting ? (
          <div className="row">
            <input placeholder="반려 사유" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
            <button
              className="small danger"
              disabled={busy}
              onClick={() => void run(r.id, () => rejectAccess({ uid: r.uid, reason }), `${r.name} 신청을 반려했습니다.`)}
            >
              반려
            </button>
            <button className="small" onClick={() => setRejecting(false)}>
              취소
            </button>
          </div>
        ) : (
          <div className="row">
            <button
              className="small primary"
              disabled={busy}
              onClick={() =>
                void run(
                  r.id,
                  () => approveAccess({ uid: r.uid, schoolId: schoolId !== r.schoolId ? schoolId : undefined }),
                  `${r.name} 신청을 승인했습니다.`,
                )
              }
            >
              승인
            </button>
            <button className="small" onClick={() => setRejecting(true)}>
              반려…
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

function SituationRow({ s, armed, busy, run, templates }: { s: SchoolProfile; armed: boolean; busy: boolean; run: Run; templates: Template[] }) {
  const [inq, setInq] = useState<InquiryRooms>(s.inquiryRooms ?? 'split');
  const [end, setEnd] = useState<EndPeriod>(s.endPeriod ?? 4);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setInq(s.inquiryRooms ?? 'split');
    setEnd(s.endPeriod ?? 4);
  }, [s.inquiryRooms, s.endPeriod]);
  const main = s.channels?.find((c) => c.id === 'main');
  const custom = !!main?.customCues;
  const nextId = csatTemplateId(inq, end);
  const changed = nextId !== main?.templateId || inq !== s.inquiryRooms || end !== s.endPeriod;
  const cues = custom ? main!.customCues! : [];
  return (
    <>
      <tr>
        <td>
          {schoolLabel({ name: s.name, examNo: s.examNo ?? null })}
          {s.special && <span className="tag special-tag">{s.venueType || '별도 운영'}</span>}
          {s.inquiryNote && <div className="muted small">{s.inquiryNote}</div>}
        </td>
        <td>
          <select value={inq} onChange={(e) => setInq(e.target.value as InquiryRooms)} disabled={armed || custom}>
            {(Object.keys(INQUIRY_ROOMS_LABEL) as InquiryRooms[]).map((k) => (
              <option key={k} value={k}>
                {INQUIRY_ROOMS_LABEL[k]}
              </option>
            ))}
          </select>
        </td>
        <td>
          <select
            value={String(end)}
            onChange={(e) => setEnd((e.target.value === 'mixed' ? 'mixed' : Number(e.target.value)) as EndPeriod)}
            disabled={armed || custom}
          >
            {([4, 5, 'mixed'] as EndPeriod[]).map((k) => (
              <option key={String(k)} value={String(k)}>
                {END_PERIOD_LABEL[k]}
              </option>
            ))}
          </select>
        </td>
        <td>{custom ? <span className="tag">학교 자체 시간표</span> : <strong>{nextId.replace('csat-', '유형 ')}</strong>}</td>
        <td>
          <button className="small link" onClick={() => setOpen(!open)}>
            {open ? '접기' : '시간표 보기'}
          </button>
        </td>
        <td className="actions">
          {armed ? (
            <span className="muted small">자동 방송 중 — 변경 불가</span>
          ) : (
            !custom && (
              <button
                className="small primary"
                disabled={!changed || busy}
                onClick={() =>
                  void run(`sit-${s.neisCode}`, () => setSchoolSituation({ schoolId: s.neisCode, inquiry: inq, end }), `${s.name}: ${nextId.replace('csat-', '유형 ')}로 바꿨습니다.`)
                }
              >
                저장
              </button>
            )
          )}
        </td>
      </tr>
      {open && (
        <tr className="sub">
          <td colSpan={6}>
            <SchedulePreview cues={custom ? cues : templates.find((t) => t.id === main?.templateId)?.cues ?? []} />
          </td>
        </tr>
      )}
    </>
  );
}

/** 시간표 미리 보기 (날짜는 표시용) */
function SchedulePreview({ cues }: { cues: Cue[] }) {
  const plan = buildPlan(cues, '2026-11-19');
  if (!plan.length) return <p className="muted">시간표가 없습니다.</p>;
  return (
    <ol className="preview">
      {plan.map(({ cue, at }) => (
        <li key={cue.id}>
          <span className="mono">{kstTime(at)}</span> <span className="muted">{cue.period}</span> {cue.label}
          {cue.examStart && <span className="tag">시험 시작</span>}
          {cue.examEnd && <span className="tag">시험 종료</span>}
        </li>
      ))}
    </ol>
  );
}
