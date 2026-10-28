import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { audioEngine, type LoadResult } from '../core/audio';
import {
  loadBuiltinAssets,
  loadGlobalConfig,
  loadSchool,
  loadSchoolAssets,
  loadTemplates,
} from '../core/catalog';
import { OS_DRIFT_WARN_MS, serverClock, type ClockStatus } from '../core/clock';
import { player, type PlayerSnapshot } from '../core/player';
import { HEARTBEAT_MS, Reporter } from '../core/reporter';
import { buildPlan, kstDate, kstEpoch, kstTime, resolveCues, shiftPlan, type CueState } from '../core/scheduler';
import type { Asset, GlobalConfig, SchoolProfile, Template } from '../core/types';
import { useSession } from '../session';

const RESYNC_MS = 10 * 60_000;

const STATE_LABEL: Record<CueState, string> = {
  pending: '대기',
  scheduled: '예약됨',
  playing: '송출 중',
  done: '송출 완료',
  skipped: '건너뜀',
  failed: '실패',
};

export default function Player() {
  const session = useSession();
  const neisCode = session.neisCode!;
  const [params, setParams] = useSearchParams();

  const [profile, setProfile] = useState<SchoolProfile | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [cfg, setCfg] = useState<GlobalConfig | null>(null);
  const [progress, setProgress] = useState<[number, number]>([0, 0]);
  const [loadResult, setLoadResult] = useState<LoadResult | null>(null);
  const [clock, setClock] = useState<ClockStatus>(serverClock.getStatus());
  const [snap, setSnap] = useState<PlayerSnapshot>(player.snapshot());
  const [now, setNow] = useState(serverClock.now());
  const [unlocked, setUnlocked] = useState(audioEngine.unlocked);
  const [wakeLock, setWakeLock] = useState(false);
  const [volume, setVolume] = useState(1);
  const [delaySec, setDelaySec] = useState(10);
  const [speed, setSpeed] = useState(1);
  const reporterRef = useRef<Reporter | null>(null);

  const channelId = params.get('channel') ?? profile?.channels[0]?.id ?? 'main';
  const channel = profile?.channels.find((c) => c.id === channelId) ?? profile?.channels[0];
  const template = templates.find((t) => t.id === channel?.templateId);
  const cues = useMemo(() => (template ? resolveCues(template, channel) : []), [template, channel]);

  const today = kstDate(now);
  const armedToday = cfg?.armedDates.find((d) => d.date === today);
  const liveDay = cfg?.armedDates.some((d) => d.date === today && d.mode === 'live') ?? false;
  const inLockWindow =
    liveDay && cfg != null && now >= kstEpoch(today, cfg.liveLockWindow.start) && now <= kstEpoch(today, cfg.liveLockWindow.end);
  const nextLive = cfg?.armedDates.filter((d) => d.mode === 'live' && d.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];

  // 1) 학교 설정·시간표·음원 목록 불러오기 + 시각 동기화
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [p, t, b, s, g] = await Promise.all([
        loadSchool(neisCode),
        loadTemplates(),
        loadBuiltinAssets().catch(() => []),
        loadSchoolAssets(neisCode),
        loadGlobalConfig(),
      ]);
      if (cancelled) return;
      setProfile(p);
      setTemplates(t);
      setAssets([...b, ...s]);
      setCfg(g);
    })();
    const unsubClock = serverClock.subscribe(setClock);
    void serverClock.sync();
    const resync = setInterval(() => void serverClock.sync(), RESYNC_MS);
    const onOnline = () => void serverClock.sync();
    window.addEventListener('online', onOnline);
    return () => {
      cancelled = true;
      unsubClock();
      clearInterval(resync);
      window.removeEventListener('online', onOnline);
    };
  }, [neisCode]);

  // 2) 이 채널에 필요한 음원을 모두 내려받아 메모리에 올림
  useEffect(() => {
    if (cues.length === 0 || assets.length === 0) return;
    const needed = new Set(cues.map((c) => c.assetId));
    const list = assets.filter((a) => needed.has(a.id));
    const missing = [...needed].filter((id) => !assets.some((a) => a.id === id));
    setLoadResult(null);
    void audioEngine.load(list, (d, t) => setProgress([d, t])).then((r) =>
      setLoadResult({ loaded: r.loaded, failed: [...r.failed, ...missing.map((id) => ({ id, error: '음원 미등록' }))] }),
    );
  }, [cues, assets]);

  // 3) 진행기 상태 구독 + 화면 시계
  useEffect(() => {
    const unsub = player.subscribe(setSnap);
    const id = setInterval(() => setNow(serverClock.now()), 200);
    return () => {
      unsub();
      clearInterval(id);
    };
  }, []);

  // 4) 서버 보고 (채널별 실시간 상태)
  useEffect(() => {
    if (!profile || !channel) return;
    const r = new Reporter(neisCode, channel.id);
    reporterRef.current = r;
    player.reporter = r;
    r.start();
    return () => {
      r.stop();
      if (player.reporter === r) player.reporter = null;
    };
  }, [neisCode, profile, channel]);

  const assetsReady = loadResult !== null && loadResult.failed.length === 0 && cues.length > 0;
  const osDriftWarn = clock.synced && Math.abs(clock.osClockDriftMs) > OS_DRIFT_WARN_MS;
  const next = snap.plan.length ? player.next() : undefined;

  useEffect(() => {
    const r = reporterRef.current;
    if (!r || !profile || !channel) return;
    const send = () => {
      const n = player.next();
      const c = player.counts();
      const st = serverClock.getStatus();
      r.update({
        schoolName: profile.name,
        channelLabel: channel.label,
        templateId: channel.templateId,
        mode: player.snapshot().mode,
        armed: player.armed,
        clockSynced: st.synced,
        clockOffsetMs: st.offsetMs,
        osClockDriftMs: Math.round(st.osClockDriftMs),
        cacheReady: assetsReady,
        missingAssets: loadResult?.failed.length ?? 0,
        audioUnlocked: audioEngine.unlocked,
        nextCue: n ? { id: n.cue.id, label: n.cue.label, at: n.at } : null,
        doneCount: c.done,
        failedCount: c.failed,
        skippedCount: c.skipped,
      });
    };
    send();
    const id = setInterval(send, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [profile, channel, assetsReady, loadResult, unlocked, snap.armed, snap.mode, next?.cue.id, clock.synced]);

  // 화면 꺼짐 방지 (탭이 다시 보이면 재요청)
  useEffect(() => {
    if (!snap.armed) return;
    let lock: WakeLockSentinel | null = null;
    const acquire = async () => {
      try {
        lock = await navigator.wakeLock.request('screen');
        setWakeLock(true);
        lock.addEventListener('release', () => setWakeLock(false));
      } catch {
        setWakeLock(false);
      }
    };
    void acquire();
    const onVis = () => document.visibilityState === 'visible' && void acquire();
    document.addEventListener('visibilitychange', onVis);
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onUnload);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('beforeunload', onUnload);
      void lock?.release();
    };
  }, [snap.armed]);

  async function unlockAudio() {
    const ok = await audioEngine.unlock();
    audioEngine.setVolume(volume);
    setUnlocked(ok);
    return ok;
  }

  async function startLive() {
    if (!armedToday || !(await unlockAudio())) return;
    player.arm(buildPlan(cues, today), armedToday.mode);
  }

  async function startRehearsal(realTime: boolean) {
    if (!(await unlockAudio())) return;
    const base = buildPlan(cues, today);
    player.arm(realTime ? base : shiftPlan(base, serverClock.now() + delaySec * 1000, speed), 'test');
  }

  if (!profile || !cfg) return <div className="center muted">학교 설정을 불러오는 중…</div>;

  const checks: { ok: boolean; warn?: boolean; label: string; detail: string }[] = [
    {
      ok: assetsReady,
      label: '음원 준비',
      detail: loadResult
        ? loadResult.failed.length
          ? `${loadResult.failed.length}개 실패: ${loadResult.failed.map((f) => f.id).join(', ')}`
          : `${loadResult.loaded.length}개 모두 준비됨`
        : `내려받는 중 ${progress[0]}/${progress[1]}`,
    },
    {
      ok: clock.synced,
      warn: osDriftWarn,
      label: '서버 시각 동기화',
      detail: clock.synced
        ? `오차 보정 ${clock.offsetMs}ms · 응답 ${clock.rttMs}ms${clock.source === 'http-date' ? ' (보조 방식)' : ''}` +
          (osDriftWarn ? ` · ⚠ PC 시계가 ${Math.round(clock.osClockDriftMs / 1000)}초 어긋나 있음 (방송은 서버 시각 기준)` : '') +
          (clock.error ? ` · ${clock.error}` : '')
        : clock.error ?? '동기화 중…',
    },
    { ok: unlocked, label: '오디오 출력', detail: unlocked ? '켜짐' : '아래 시작 버튼을 누르면 켜집니다' },
    { ok: !snap.armed || wakeLock, label: '화면 꺼짐 방지', detail: snap.armed ? (wakeLock ? '켜짐' : '지원 안 됨 — 전원 설정에서 절전을 끄세요') : '방송 시작 시 켜짐' },
  ];
  const allReady = assetsReady && clock.synced;

  return (
    <div className="player">
      <header className="bar">
        <div>
          <strong>{profile.name}</strong>
          {profile.channels.length > 1 ? (
            <select value={channel?.id} onChange={(e) => setParams({ channel: e.target.value })} disabled={snap.armed}>
              {profile.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          ) : (
            <span className="muted"> · {channel?.label}</span>
          )}
          <span className="muted"> · {template?.name}</span>
        </div>
        <div className="bar-right">
          {session.localMode && <span className="tag">로컬 모드</span>}
          {snap.mode !== 'idle' && <span className={`tag ${snap.mode}`}>{snap.mode === 'live' ? '실전' : '테스트'}</span>}
          <button className="link" onClick={() => void session.logout()} disabled={snap.armed}>
            로그아웃
          </button>
        </div>
      </header>

      {template && !template.verified && (
        <div className="banner warn">⚠ 이 시간표는 아직 공식 시간표로 검증되지 않은 초안입니다. 실전 전 반드시 확인하세요.</div>
      )}

      <section className="clock-panel">
        <div className="clock">{kstTime(now)}</div>
        <div className="muted">
          {today} (서버 시각){nextLive && nextLive.date !== today && ` · ${nextLive.label}까지 D-${dday(today, nextLive.date)}`}
        </div>
        {next ? (
          <div className="next">
            다음 방송 <strong>{next.cue.label}</strong> <span className="muted">({next.cue.period})</span>
            <div className="countdown">{countdown(next.at - now)}</div>
            <div className="muted">{kstTime(next.at)} 예정</div>
          </div>
        ) : snap.armed ? (
          <div className="next">오늘 남은 방송이 없습니다.</div>
        ) : null}
      </section>

      <section className="card">
        <h2>방송 준비 점검</h2>
        <ul className="checks">
          {checks.map((c) => (
            <li key={c.label} className={c.ok ? (c.warn ? 'warn' : 'ok') : 'bad'}>
              <span className="dot" />
              <strong>{c.label}</strong> <span className="muted">{c.detail}</span>
            </li>
          ))}
        </ul>
        <div className="row">
          <label className="row">
            볼륨
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(e) => {
                const v = Number(e.target.value);
                setVolume(v);
                audioEngine.setVolume(v);
              }}
            />
          </label>
          <button onClick={async () => (await unlockAudio()) && audioEngine.testTone()}>🔊 테스트 소리</button>
        </div>
      </section>

      <section className="card">
        {snap.armed ? (
          <>
            <h2>{snap.mode === 'live' ? '자동 방송 진행 중' : '테스트 방송 진행 중'}</h2>
            <p className="muted">이 창을 닫거나 PC를 절전 상태로 두지 마세요. 다른 탭으로 이동해도 방송은 계속됩니다.</p>
            <div className="row">
              <button className="danger big" onClick={() => player.stopAll()}>
                ■ 지금 나오는 소리 정지
              </button>
              <button onClick={() => confirmDisarm(snap.mode === 'live')}>자동 방송 중지</button>
            </div>
          </>
        ) : armedToday ? (
          <>
            <h2>{armedToday.label}</h2>
            <p>시간표에 맞춰 자동으로 방송합니다. 준비 점검이 모두 초록색인지 확인한 뒤 누르세요.</p>
            <button className="primary huge" disabled={!allReady} onClick={() => void startLive()}>
              ▶ 자동 방송 시작
            </button>
          </>
        ) : (
          <>
            <h2>테스트 / 리허설</h2>
            <p className="muted">실제 방송일이 아니므로 테스트만 할 수 있습니다. 기록은 테스트로 표시됩니다.</p>
            <div className="row">
              <label>
                시작까지
                <input type="number" min={0} value={delaySec} onChange={(e) => setDelaySec(Number(e.target.value))} />초
              </label>
              <label>
                배속
                <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                  <option value={1}>1배 (실제 간격)</option>
                  <option value={10}>10배</option>
                  <option value={60}>60배</option>
                </select>
              </label>
              <button className="primary" disabled={!assetsReady || inLockWindow} onClick={() => void startRehearsal(false)}>
                ▶ 리허설 시작
              </button>
              <button disabled={!assetsReady || inLockWindow} onClick={() => void startRehearsal(true)}>
                오늘 실제 시각으로 테스트
              </button>
            </div>
          </>
        )}
        {inLockWindow && !snap.armed && <p className="error">수능 당일 운영 시간에는 테스트 기능이 잠겨 있습니다.</p>}
      </section>

      <section className="card">
        <h2>오늘 시간표</h2>
        <table className="timeline">
          <thead>
            <tr>
              <th>시각</th>
              <th>교시</th>
              <th>내용</th>
              <th>상태</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(snap.plan.length ? snap.plan : buildPlan(cues, today)).map(({ cue, at }) => {
              const st = snap.states[cue.id] ?? 'pending';
              return (
                <tr key={cue.id} className={`st-${st} ${next?.cue.id === cue.id ? 'is-next' : ''}`}>
                  <td className="mono">{kstTime(at)}</td>
                  <td>{cue.period}</td>
                  <td>
                    {cue.kind === 'bell' ? '🔔 ' : '📢 '}
                    {cue.label}
                    {!cue.official && <span className="tag">학교 추가</span>}
                  </td>
                  <td>{snap.plan.length ? STATE_LABEL[st] : ''}</td>
                  <td>
                    <button
                      className="small"
                      disabled={!audioEngine.has(cue.assetId)}
                      onClick={async () => {
                        await unlockAudio();
                        if (snap.plan.length) player.playNow(cue.id);
                        else audioEngine.playAt(cue.assetId, 0, 0);
                      }}
                      title="이 방송을 지금 즉시 재생"
                    >
                      ▶ 지금 재생
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {snap.events.length > 0 && (
        <section className="card">
          <h2>기록</h2>
          <ul className="events">
            {snap.events.slice(0, 30).map((e, i) => (
              <li key={i} className={e.level}>
                <span className="mono">{kstTime(e.at)}</span> {e.message}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function confirmDisarm(live: boolean) {
  // 실전 중지는 실수 방지를 위해 한 번 더 확인
  if (live && !window.confirm('실전 자동 방송을 중지할까요? 이후 방송은 수동으로 해야 합니다.')) return;
  player.disarm();
}

function countdown(ms: number) {
  if (ms <= 0) return '곧 송출';
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}시간 ${m}분 ${sec}초` : m ? `${m}분 ${sec}초` : `${sec}초`;
}

function dday(from: string, to: string) {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}
