import { collection, getDocs } from 'firebase/firestore';
import { onValue, ref } from 'firebase/database';
import { useEffect, useState } from 'react';
import { serverClock } from '../core/clock';
import { fb } from '../core/firebase';
import type { ChannelStatus } from '../core/reporter';
import { kstTime } from '../core/scheduler';
import type { SchoolProfile } from '../core/types';
import { useSession } from '../session';

type Health = 'ok' | 'warn' | 'bad' | 'none';

const STALE_MS = 90_000;
const LATE_REPORT_MS = 15_000;

/** 채널 상태를 초록/노랑/빨강으로 판정하고 사유를 붙인다. */
export function judge(s: ChannelStatus | undefined, now: number): { health: Health; reasons: string[] } {
  if (!s) return { health: 'none', reasons: ['접속 기록 없음'] };
  const bad: string[] = [];
  const warn: string[] = [];
  if (!s.online || now - s.lastSeen > STALE_MS) {
    bad.push(s.armed ? '연결 끊김 (PC에서 재생은 계속될 수 있음)' : '연결 끊김');
  }
  if (s.failedCount > 0) bad.push(`재생 실패 ${s.failedCount}건`);
  if (s.armed && s.nextCue && now > s.nextCue.at + LATE_REPORT_MS) bad.push(`'${s.nextCue.label}' 송출 보고 지연`);
  if (!s.cacheReady) warn.push(s.missingAssets ? `음원 ${s.missingAssets}개 누락` : '음원 준비 중');
  if (!s.clockSynced) warn.push('시각 미동기화');
  if (!s.audioUnlocked) warn.push('오디오 꺼짐');
  if (!s.armed) warn.push('자동 방송 대기 아님');
  if (s.skippedCount > 0) warn.push(`건너뜀 ${s.skippedCount}건`);
  if (bad.length) return { health: 'bad', reasons: [...bad, ...warn] };
  if (warn.length) return { health: 'warn', reasons: warn };
  return { health: 'ok', reasons: ['정상'] };
}

export default function StatusBoard() {
  const session = useSession();
  const [status, setStatus] = useState<Record<string, Record<string, ChannelStatus>>>({});
  const [schools, setSchools] = useState<SchoolProfile[]>([]);
  const [now, setNow] = useState(serverClock.now());
  const [onlyProblems, setOnlyProblems] = useState(false);

  useEffect(() => {
    if (!fb) return;
    void serverClock.sync();
    const unsub = onValue(ref(fb.rtdb, 'status'), (snap) => setStatus(snap.val() ?? {}));
    void getDocs(collection(fb.db, 'schools')).then((s) =>
      setSchools(s.docs.map((d) => ({ ...(d.data() as SchoolProfile), neisCode: d.id }))),
    );
    const id = setInterval(() => setNow(serverClock.now()), 1000);
    return () => {
      unsub();
      clearInterval(id);
    };
  }, []);

  if (!fb) return <div className="center">상태판은 서버 연결이 필요합니다.</div>;

  // 등록된 학교 + 등록은 안 됐지만 접속한 학교 모두 표시
  const codes = new Set([...schools.map((s) => s.neisCode), ...Object.keys(status)]);
  const rows = [...codes].flatMap((code) => {
    const school = schools.find((s) => s.neisCode === code);
    const chans = school?.channels?.map((c) => c.id) ?? [];
    const ids = new Set([...chans, ...Object.keys(status[code] ?? {})]);
    if (ids.size === 0) ids.add('main');
    return [...ids].map((ch) => {
      const s = status[code]?.[ch];
      return {
        code,
        ch,
        name: school?.name ?? s?.schoolName ?? code,
        label: school?.channels?.find((c) => c.id === ch)?.label ?? s?.channelLabel ?? ch,
        s,
        ...judge(s, now),
      };
    });
  });
  const order: Record<Health, number> = { bad: 0, warn: 1, none: 2, ok: 3 };
  rows.sort((a, b) => order[a.health] - order[b.health] || a.name.localeCompare(b.name, 'ko'));
  const count = (h: Health) => rows.filter((r) => r.health === h).length;
  const shown = onlyProblems ? rows.filter((r) => r.health !== 'ok') : rows;

  return (
    <div className="board">
      <header className="bar">
        <strong>시험장 방송 상태</strong>
        <span className="mono">{kstTime(now)}</span>
        <button className="link" onClick={() => void session.logout()}>
          로그아웃
        </button>
      </header>

      <div className="summary">
        <div className="sum ok">정상 {count('ok')}</div>
        <div className="sum warn">주의 {count('warn')}</div>
        <div className="sum bad">문제 {count('bad')}</div>
        <div className="sum none">미접속 {count('none')}</div>
        <label className="row">
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
          문제 있는 곳만
        </label>
      </div>

      <div className="grid">
        {shown.map((r) => (
          <div key={`${r.code}/${r.ch}`} className={`tile ${r.health}`}>
            <div className="tile-head">
              <strong>{r.name}</strong>
              <span className="muted">{r.label}</span>
              {r.s?.mode && r.s.mode !== 'idle' && <span className={`tag ${r.s.mode}`}>{r.s.mode === 'live' ? '실전' : '테스트'}</span>}
            </div>
            <ul className="reasons">
              {r.reasons.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
            {r.s && (
              <div className="tile-foot muted">
                {r.s.lastCue && (
                  <div>
                    최근: {r.s.lastCue.label} ({resultLabel(r.s.lastCue.result)})
                  </div>
                )}
                {r.s.nextCue && (
                  <div>
                    다음: {kstTime(r.s.nextCue.at)} {r.s.nextCue.label}
                  </div>
                )}
                <div>
                  완료 {r.s.doneCount ?? 0} · 마지막 신호 {Math.max(0, Math.round((now - r.s.lastSeen) / 1000))}초 전 · v{r.s.appVersion}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function resultLabel(r: string) {
  return { played: '송출', skipped: '건너뜀', failed: '실패', manual: '수동' }[r] ?? r;
}
