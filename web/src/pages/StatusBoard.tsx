import HistoryIcon from '@mui/icons-material/HistoryOutlined';
import HowToRegIcon from '@mui/icons-material/HowToRegOutlined';
import SensorsIcon from '@mui/icons-material/SensorsOutlined';
import { Chip } from '@mui/material';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import AppShell, { type NavItem } from '../components/AppShell';
import { useEffect, useMemo, useRef, useState } from 'react';
import { nextAcross } from '../core/board';
import { fb } from '../core/firebase';
import { kstDate, kstTime } from '../core/scheduler';
import { useSession } from '../session';
import AccessAdmin from './admin/AccessAdmin';
import LiveBoard, { CellLegend } from './admin/LiveBoard';
import PlayLogs from './admin/PlayLogs';
import SpecialVenue, { countdown } from './admin/SpecialVenue';
import { buildRows, useAdminData, type ChannelRow, type Health, type ModeFilter } from './admin/data';

type Tab = 'live' | 'access' | 'logs';
const ORDER: Record<Health, number> = { bad: 0, warn: 1, none: 2, ok: 3 };

/** 교육지원청 관리자 화면: 송출 현황 / 사용 신청·학교 관리 / 송출 기록 */
export default function StatusBoard() {
  const session = useSession();
  const data = useAdminData();
  const { now, connected } = data;
  const [tab, setTab] = useState<Tab>('live');
  const [mode, setMode] = useState<ModeFilter>('all');
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [sortByHealth, setSortByHealth] = useState(false);
  const [alertSound, setAlertSound] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const prevBad = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!fb) return;
    return onSnapshot(query(collection(fb.db, 'accessRequests'), where('status', '==', 'pending')), (s) => setPendingCount(s.size));
  }, []);

  // 상태판을 떠나면 탭 제목('(n) 문제 …')을 되돌린다
  useEffect(() => () => void (document.title = '수능 방송 스케줄러'), []);

  const rows = useMemo(() => buildRows(data, mode), [data.status, data.presence, data.schools, data.templates, now, mode]);
  const special = rows.filter((r) => r.special);
  const general = rows.filter((r) => !r.special);

  // 새로 '문제'가 생긴 시험장이 있으면 경고음 + 탭 제목에 표시 (다른 창을 보고 있어도 알 수 있게)
  useEffect(() => {
    const badNow = new Set(rows.filter((r) => r.health === 'bad').map((r) => `${r.code}/${r.ch}|${r.reasons[0]}`));
    const newlyBad = [...badNow].some((k) => !prevBad.current.has(k));
    prevBad.current = badNow;
    const n = rows.filter((r) => r.health === 'bad').length;
    document.title = n ? `(${n}) 문제 — 방송 상태판` : '방송 상태판';
    if (newlyBad && alertSound) beep();
  }, [rows, alertSound]);

  if (!fb) return <div className="center">상태판은 서버 연결이 필요합니다.</div>;

  const count = (h: Health) => rows.filter((r) => r.health === h).length;
  const next = nextAcross(
    rows.map((r) => ({ timeline: r.timeline, armed: r.armed, ready: r.health !== 'bad' && !!r.s?.cacheReady })),
    now,
  );
  const sortRows = (list: ChannelRow[]) =>
    [...list].sort(
      (a, b) =>
        (sortByHealth ? ORDER[a.health] - ORDER[b.health] : 0) ||
        (a.examNo ?? 999) - (b.examNo ?? 999) ||
        a.name.localeCompare(b.name, 'ko') ||
        a.ch.localeCompare(b.ch),
    );
  const shownGeneral = sortRows(onlyProblems ? general.filter((r) => r.health !== 'ok') : general);

  const nav: NavItem<Tab>[] = [
    {
      key: 'live',
      label: '송출 현황',
      icon: <SensorsIcon fontSize="small" />,
      badge: count('bad') > 0 ? { label: count('bad'), color: 'error' } : undefined,
    },
    {
      key: 'access',
      label: '사용 신청·학교 관리',
      icon: <HowToRegIcon fontSize="small" />,
      badge: pendingCount > 0 ? { label: pendingCount, color: 'warning' } : undefined,
    },
    { key: 'logs', label: '송출 기록', icon: <HistoryIcon fontSize="small" /> },
  ];

  return (
    <AppShell<Tab>
      subtitle="제13시험지구 · 교육지원청"
      nav={nav}
      active={tab}
      onSelect={setTab}
      status={
        connected ? (
          <Chip size="small" variant="outlined" color="success" label="서버 연결됨" />
        ) : (
          <Chip size="small" color="error" label="서버 연결 끊김 — 화면이 최신이 아님" />
        )
      }
      right={<span className="mono big-clock">{kstTime(now)}</span>}
      operator={session.operator}
      email={session.user?.email}
      onLogout={() => void session.logout()}
    >
    <div className="board">
      {tab === 'live' && (
        <>
          <div className={`live-layout ${special.length ? 'has-side' : ''}`}>
            <div className="live-main">
          <div className="summary">
            <div className="sum ok">정상 {count('ok')}</div>
            <div className="sum warn">주의 {count('warn')}</div>
            <div className="sum bad">문제 {count('bad')}</div>
            <div className="sum none">미접속 {count('none')}</div>
            <div className={`next-across ${next && next.notReady ? 'bad' : ''}`}>
              {next ? (
                <>
                  다음 방송 <strong className="mono">{kstTime(next.at)}</strong> {next.labels.join(' / ')}
                  <span className="muted">
                    {' '}
                    · {countdown(next.at - now)} 후 · {next.schools}곳 송출 예정
                    {next.notReady > 0 && <strong className="error"> · {next.notReady}곳 문제</strong>}
                  </span>
                </>
              ) : (
                <span className="muted">자동 방송 대기 중인 시험장 없음 ({kstDate(now)})</span>
              )}
            </div>
          </div>
          <div className="row controls">
            <select value={mode} onChange={(e) => setMode(e.target.value as ModeFilter)}>
              <option value="all">실전·테스트 모두 표시</option>
              <option value="live">실전 방송만</option>
              <option value="test">테스트·리허설만</option>
            </select>
            <label className="row">
              <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
              문제 있는 곳만
            </label>
            <label className="row">
              <input type="checkbox" checked={sortByHealth} onChange={(e) => setSortByHealth(e.target.checked)} />
              문제 순으로 정렬
            </label>
            <label className="row">
              <input
                type="checkbox"
                checked={alertSound}
                onChange={(e) => {
                  setAlertSound(e.target.checked);
                  if (e.target.checked) beep();
                }}
              />
              문제 발생 시 경고음
            </label>
          </div>

              <section className="card">
                <h2>일반 시험장 {general.length}곳</h2>
                <LiveBoard rows={shownGeneral} now={now} />
                <CellLegend />
              </section>

              <ProblemList rows={sortRows(rows.filter((r) => r.health === 'bad' || r.health === 'warn'))} />

              <p className="muted small footnote">
                이 화면은 학교 PC가 보내는 보고를 보여 주기만 합니다. 이 화면을 닫거나 인터넷이 끊겨도 학교 방송에는 영향이 없습니다.
                학교 PC는 서버 시각에 맞춰 스스로 송출하고, 보고가 늦으면 15초 뒤 '송출 보고 없음'으로 표시됩니다.
              </p>
            </div>

            {special.length > 0 && (
              <aside className="live-side">
                {special.map((r) => (
                  <SpecialVenue key={`${r.code}/${r.ch}`} row={r} now={now} />
                ))}
              </aside>
            )}
          </div>
        </>
      )}

      {tab === 'access' && <AccessAdmin schools={data.schools} rows={rows} templates={data.templates} />}
      {tab === 'logs' && <PlayLogs schools={data.schools} now={now} />}
    </div>
    </AppShell>
  );
}

/** 시험장별 문제·주의 사유 전체 목록 */
function ProblemList({ rows }: { rows: ChannelRow[] }) {
  if (!rows.length) return null;
  return (
    <section className="card">
      <h2>확인이 필요한 시험장</h2>
      <ul className="problems">
        {rows.map((r) => (
          <li key={`${r.code}/${r.ch}`} className={r.health}>
            <strong>{r.name}</strong>
            {r.ch !== 'main' && <span className="muted"> · {r.label}</span>}
            {r.s?.operator && <span className="muted"> · {r.s.operator}</span>}
            <ul>
              {r.reasons.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
            {r.devices.length > 1 && (
              <div className="muted small">
                열린 PC: {r.devices.map((d) => `${d.name || d.email || d.uid}(${new Date(d.since).toLocaleTimeString('ko-KR')}~)`).join(', ')}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

let alertCtx: AudioContext | null = null;
function beep() {
  alertCtx ??= new AudioContext();
  const t = alertCtx.currentTime;
  for (let i = 0; i < 3; i++) {
    const osc = alertCtx.createOscillator();
    const g = alertCtx.createGain();
    osc.frequency.value = 1000;
    g.gain.setValueAtTime(0.3, t + i * 0.3);
    g.gain.setValueAtTime(0, t + i * 0.3 + 0.18);
    osc.connect(g).connect(alertCtx.destination);
    osc.start(t + i * 0.3);
    osc.stop(t + i * 0.3 + 0.2);
  }
}
