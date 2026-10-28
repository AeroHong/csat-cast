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
import { loadRun, saveRun } from '../core/runStore';
import { buildPlan, kstDate, kstEpoch, kstTime, resolveCues, shiftPlan, type CueState } from '../core/scheduler';
import type { Asset, GlobalConfig, SchoolProfile, Template } from '../core/types';
import { onUpdatePending } from '../core/updates';
import { useSession } from '../session';

const RESYNC_MS = 10 * 60_000;

const STATE_LABEL: Record<CueState, string> = {
  pending: '대기',
  scheduled: '곧 송출',
  playing: '송출 중',
  done: '송출 완료',
  skipped: '건너뜀',
  failed: '실패',
};

type SoundCheck = 'unknown' | 'heard' | 'not-heard';

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
  const [autoplayAllowed, setAutoplayAllowed] = useState(false);
  const [wakeLock, setWakeLock] = useState(false);
  const [volume, setVolume] = useState(1);
  const [delaySec, setDelaySec] = useState(10);
  const [speed, setSpeed] = useState(1);
  const [sound, setSound] = useState<SoundCheck>('unknown');
  const [tonePlayed, setTonePlayed] = useState(false);
  const [updatePending, setUpdatePending] = useState(false);
  /** 같은 채널을 다른 탭에서 이미 열었는가 (이중 송출 방지) */
  const [duplicateTab, setDuplicateTab] = useState(false);
  const reporterRef = useRef<Reporter | null>(null);

  const channelId = params.get('channel') ?? profile?.channels[0]?.id ?? 'main';
  const channel = profile?.channels.find((c) => c.id === channelId) ?? profile?.channels[0];
  const template = templates.find((t) => t.id === channel?.templateId);
  const cues = useMemo(() => (template ? resolveCues(template, channel) : []), [template, channel]);

  const today = kstDate(now);
  // 개발 서버 전용: ?devArmed=1 이면 오늘을 방송일로 가정하고 시간표를 '곧 시작, 60배속'으로 당겨 자동 시작·이어하기를 시험
  const devArmed = import.meta.env.DEV && params.get('devArmed') === '1';
  const armedToday =
    cfg?.armedDates.find((d) => d.date === today) ??
    (devArmed ? { date: today, mode: 'test' as const, label: '[개발] 방송일 시뮬레이션' } : undefined);
  const todayPlan = () => (devArmed ? shiftPlan(buildPlan(cues, today), devStartAt(), 60) : buildPlan(cues, today));
  const liveDay = cfg?.armedDates.some((d) => d.date === today && d.mode === 'live') ?? false;
  const inLockWindow =
    liveDay && cfg != null && now >= kstEpoch(today, cfg.liveLockWindow.start) && now <= kstEpoch(today, cfg.liveLockWindow.end);
  const nextArmed = cfg?.armedDates
    .filter((d) => d.date > today)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  const soundKey = channel ? `csat-cast:sound:${neisCode}:${channel.id}:${today}` : null;

  // 1) 학교 설정·시간표·음원 목록 불러오기 + 시각 동기화 + 클릭 없이 소리 켜기 시도
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
    void audioEngine.tryResume().then((ok) => {
      setAutoplayAllowed(ok);
      setUnlocked(ok);
    });
    const unsubAudio = audioEngine.onStateChange(() => setUnlocked(audioEngine.unlocked));
    // 화면 어디를 클릭해도 소리가 켜지게 한다 (꺼져 있을 때 가장 쉬운 복구 방법)
    const onPointer = () => {
      if (!audioEngine.unlocked) void audioEngine.unlock().then(setUnlocked);
    };
    window.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onPointer);
    const unsubClock = serverClock.subscribe(setClock);
    void serverClock.sync();
    const resync = setInterval(() => void serverClock.sync(), RESYNC_MS);
    const onOnline = () => void serverClock.sync();
    window.addEventListener('online', onOnline);
    const unsubUpdate = onUpdatePending(setUpdatePending);
    return () => {
      cancelled = true;
      unsubAudio();
      unsubClock();
      unsubUpdate();
      clearInterval(resync);
      window.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onPointer);
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

  // 4) 같은 채널은 한 탭에서만 방송 (Web Locks). 먼저 연 탭이 닫히면 자동으로 이어받는다.
  useEffect(() => {
    if (!channel || !('locks' in navigator)) return;
    const ctrl = new AbortController();
    let held = false;
    const name = `csat-cast:${neisCode}:${channel.id}`;
    void navigator.locks
      .request(name, { ifAvailable: true }, async (lock) => {
        if (lock) return hold();
        setDuplicateTab(true);
        // 먼저 연 탭이 닫히기를 기다렸다가 이어받음
        return navigator.locks.request(name, { signal: ctrl.signal }, hold);
      })
      .catch(() => undefined);
    function hold() {
      held = true;
      setDuplicateTab(false);
      return new Promise<void>((resolve) => ctrl.signal.addEventListener('abort', () => resolve()));
    }
    return () => {
      ctrl.abort();
      if (held) setDuplicateTab(false);
    };
  }, [neisCode, channel]);

  // 5) 서버 보고 (채널별 실시간 상태)
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

  // 6) 스피커 확인 결과는 오늘 하루 동안 기억
  useEffect(() => {
    if (!soundKey) return;
    try {
      setSound((localStorage.getItem(soundKey) as SoundCheck | null) ?? 'unknown');
    } catch {
      setSound('unknown');
    }
  }, [soundKey]);

  function confirmSound(v: SoundCheck) {
    setSound(v);
    try {
      if (soundKey) localStorage.setItem(soundKey, v);
    } catch {
      /* 저장소 사용 불가 */
    }
  }

  const loaded = loadResult !== null;
  const assetsReady = loaded && loadResult.failed.length === 0 && cues.length > 0;
  const clockUsable = clock.synced || clock.source === 'cached';
  const osDriftWarn = clockUsable && Math.abs(clock.osClockDriftMs) > OS_DRIFT_WARN_MS;
  const next = snap.plan.length ? player.next() : undefined;
  const savedRun = channel ? loadRun(neisCode, channel.id, today) : null;
  const stoppedToday = savedRun?.stoppedByUser ?? false;
  const runningToday = snap.armed && snap.runDate === today;

  // 7) 실제 방송일(실전·공식 리허설)에는 화면을 열기만 하면 자동으로 시작/이어서 진행
  useEffect(() => {
    if (!armedToday || !channel || !loaded || cues.length === 0 || duplicateTab) return;
    if (runningToday || stoppedToday) return;
    // 방송일 화면에서는 리허설을 시작할 수 없으므로, 돌고 있는 리허설은 전날 켜 둔 것 → 실제 방송으로 교체
    const saved = loadRun(neisCode, channel.id, today);
    player.arm(todayPlan(), armedToday.mode, { restore: saved?.states, date: today });
  }, [armedToday?.date, channel, loaded, cues, duplicateTab, runningToday, stoppedToday, neisCode, today]);

  // 8) 진행 상태를 PC에 저장 (새로고침·재시작 후 이어하기)
  useEffect(() => {
    if (!channel || !snap.runDate || snap.mode === 'idle') return;
    saveRun(neisCode, channel.id, {
      date: snap.runDate,
      mode: snap.mode,
      states: snap.states,
      stoppedByUser: false,
      savedAt: Date.now(),
    });
  }, [snap, neisCode, channel]);

  // 9) 날짜가 바뀌면(예: 리허설 날 켜 둔 채로 실전 날 아침) 어제 방송을 정리
  useEffect(() => {
    if (snap.armed && snap.runDate && snap.runDate !== today) player.disarm(false);
  }, [snap.armed, snap.runDate, today]);

  // 10) 서버로 상태 보고 (변화가 있을 때 + 30초마다)
  useEffect(() => {
    const r = reporterRef.current;
    if (!r || !profile || !channel) return;
    const send = () => {
      const n = player.next();
      const c = player.counts();
      const st = serverClock.getStatus();
      const s = player.snapshot();
      r.update({
        schoolName: profile.name,
        channelLabel: channel.label,
        templateId: channel.templateId,
        mode: s.mode,
        armed: s.armed,
        clockSynced: st.synced || st.source === 'cached',
        clockOffsetMs: st.offsetMs,
        osClockDriftMs: Math.round(st.osClockDriftMs),
        cacheReady: assetsReady,
        missingAssets: loadResult?.failed.length ?? 0,
        audioUnlocked: audioEngine.unlocked,
        autoplayAllowed,
        soundConfirmed: sound === 'heard',
        alarms: s.alarms,
        nextCue: n ? { id: n.cue.id, label: n.cue.label, at: n.at } : null,
        doneCount: c.done,
        failedCount: c.failed,
        skippedCount: c.skipped,
      });
    };
    send();
    const id = setInterval(send, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [profile, channel, assetsReady, loadResult, unlocked, autoplayAllowed, sound, snap.armed, snap.mode, snap.alarms.length, next?.cue.id, clock.synced, clock.source]);

  // 화면 꺼짐 방지 (탭이 다시 보이면 재요청) + 실수로 창 닫기 방지
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

  async function playTestTone() {
    if (!(await unlockAudio())) return;
    audioEngine.testTone();
    setTonePlayed(true);
  }

  function restartToday() {
    if (!armedToday || !channel) return;
    void unlockAudio();
    player.arm(todayPlan(), armedToday.mode, { restore: savedRun?.states, date: today });
  }

  function stopAuto() {
    // 실전 중지는 실수 방지를 위해 한 번 더 확인
    if (snap.mode === 'live' && !window.confirm('실전 자동 방송을 중지할까요? 이후 방송은 직접 해야 합니다.')) return;
    const runDate = snap.runDate;
    player.disarm(true);
    if (runDate && channel) {
      saveRun(neisCode, channel.id, {
        date: runDate,
        mode: snap.mode === 'idle' ? 'test' : snap.mode,
        states: snap.states,
        stoppedByUser: true,
        savedAt: Date.now(),
      });
    }
  }

  async function startRehearsal(realTime: boolean) {
    await unlockAudio();
    const base = buildPlan(cues, today);
    player.arm(realTime ? base : shiftPlan(base, serverClock.now() + delaySec * 1000, speed), 'test');
  }

  if (!profile || !cfg) return <div className="center muted">학교 설정을 불러오는 중…</div>;

  if (duplicateTab) {
    return (
      <div className="center">
        <div className="card narrow">
          <h2>이 방송은 이미 다른 창에서 진행 중입니다</h2>
          <p>같은 방송을 두 곳에서 틀면 소리가 겹칩니다. 이 창은 닫아 주세요.</p>
          <p className="muted">다른 창을 닫으면 이 창이 자동으로 이어받습니다.</p>
        </div>
      </div>
    );
  }

  // 화면 맨 위에 보여 줄 한 줄 요약 (가장 중요한 것 하나만)
  const headline = summarize({
    armed: snap.armed,
    mode: snap.mode,
    audioOn: unlocked,
    alarms: snap.alarms,
    loaded,
    assetsReady,
    clockUsable,
    armedTodayLabel: armedToday?.label,
    stoppedToday,
    next: next ? `${kstTime(next.at)} ${next.cue.label}` : null,
  });

  const checks: { ok: boolean; warn?: boolean; label: string; detail: string }[] = [
    {
      ok: assetsReady,
      label: '음원',
      detail: loadResult
        ? loadResult.failed.length
          ? `${loadResult.failed.length}개 준비 실패 (해당 방송은 직접 하셔야 합니다): ${loadResult.failed.map((f) => f.id).join(', ')}`
          : `${loadResult.loaded.length}개 모두 준비됨 (인터넷이 끊겨도 재생 가능)`
        : `내려받는 중 ${progress[0]}/${progress[1]}`,
    },
    {
      ok: clockUsable,
      warn: osDriftWarn || (clockUsable && !clock.synced),
      label: '시각',
      detail: clock.synced
        ? `서버 시각과 일치 (보정 ${clock.offsetMs}ms)` +
          (osDriftWarn ? ` · 참고: PC 시계가 ${Math.round(clock.osClockDriftMs / 1000)}초 틀려 있지만 방송은 서버 시각으로 정확히 나갑니다` : '')
        : clock.source === 'cached'
          ? '인터넷 연결 없음 — 마지막으로 맞춘 서버 시각 사용 중'
          : clock.error ?? '서버 시각 맞추는 중…',
    },
    {
      ok: unlocked,
      label: '소리 출력',
      detail: unlocked ? (autoplayAllowed ? '켜짐 (자동)' : '켜짐') : '꺼짐 — 화면 아무 곳이나 한 번 클릭하세요',
    },
    {
      ok: sound === 'heard',
      warn: sound === 'unknown',
      label: '스피커 확인',
      detail:
        sound === 'heard'
          ? '오늘 확인 완료'
          : sound === 'not-heard'
            ? '소리가 안 들림 — 아래 점검 방법 확인'
            : '아래 [테스트 소리]를 눌러 교실 스피커에서 들리는지 확인하세요',
    },
    {
      ok: !snap.armed || wakeLock,
      warn: snap.armed && !wakeLock,
      label: '화면 꺼짐 방지',
      detail: snap.armed ? (wakeLock ? '켜짐' : '지원 안 됨 — Windows 전원 설정에서 절전을 "안 함"으로') : '방송 시작 시 자동으로 켜짐',
    },
  ];

  return (
    <div className="player">
      {snap.armed && !unlocked && (
        <button className="overlay" onClick={() => void unlockAudio()}>
          <span className="overlay-title">🔇 소리가 꺼져 있습니다</span>
          <span>화면을 한 번 클릭하면 방송 소리가 켜집니다</span>
        </button>
      )}

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

      <div className={`headline ${headline.level}`}>
        <div className="headline-title">{headline.title}</div>
        {headline.detail && <div>{headline.detail}</div>}
      </div>

      {template && !template.verified && (
        <div className="banner warn">⚠ 이 시간표는 아직 공식 시간표로 검증되지 않은 초안입니다.</div>
      )}
      {updatePending && (
        <div className="banner">새 버전이 준비되어 있습니다. 방송이 끝난 뒤 자동으로 적용됩니다 (방송 중에는 적용하지 않음).</div>
      )}

      <section className="clock-panel">
        <div className="clock">{kstTime(now)}</div>
        <div className="muted">
          {today} 서버 시각{!armedToday && nextArmed && ` · ${nextArmed.label}까지 D-${dday(today, nextArmed.date)}`}
        </div>
        {next ? (
          <div className="next">
            다음 방송 <strong>{next.cue.label}</strong> <span className="muted">({next.cue.period})</span>
            <div className="countdown">{countdown(next.at - now)}</div>
            <div className="muted">{kstTime(next.at)} 송출 예정</div>
          </div>
        ) : snap.armed ? (
          <div className="next">오늘 예정된 방송을 모두 마쳤습니다.</div>
        ) : null}
      </section>

      <section className="card">
        <h2>방송 준비 점검</h2>
        <ul className="checks">
          {checks.map((c) => (
            <li key={c.label} className={c.ok ? (c.warn ? 'warn' : 'ok') : c.warn ? 'warn' : 'bad'}>
              <span className="dot" />
              <strong>{c.label}</strong> <span className="muted">{c.detail}</span>
            </li>
          ))}
        </ul>
        <div className="row">
          <button onClick={() => void playTestTone()}>🔊 테스트 소리</button>
          {(tonePlayed || sound !== 'unknown') && (
            <>
              <button className={sound === 'heard' ? 'primary' : ''} onClick={() => confirmSound('heard')}>
                들렸어요
              </button>
              <button className={sound === 'not-heard' ? 'danger' : ''} onClick={() => confirmSound('not-heard')}>
                안 들려요
              </button>
            </>
          )}
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
        </div>
        {sound === 'not-heard' && (
          <ol className="help">
            <li>방송 앰프 전원과 볼륨, 이 PC와 앰프를 잇는 케이블을 확인하세요.</li>
            <li>Windows 작업 표시줄 스피커 아이콘에서 음소거가 아닌지, 출력 장치가 앰프 쪽인지 확인하세요.</li>
            <li>다시 [테스트 소리]를 눌러 보세요. 그래도 안 되면 교육지원청 담당자에게 연락하세요.</li>
          </ol>
        )}
      </section>

      {!autoplayAllowed && !session.localMode && (
        <section className="card">
          <h2>전용 실행 아이콘 (권장)</h2>
          <p>
            이 아이콘으로 열면 PC가 다시 켜지거나 화면이 새로고침되어도 <strong>클릭 없이 방송이 이어집니다</strong>.
          </p>
          <ol className="help">
            <li>
              <a href="/launcher/csat-cast-launcher.bat" download="수능방송.bat">
                실행 아이콘 내려받기
              </a>{' '}
              → 바탕화면에 저장
            </li>
            <li>저장한 파일을 두 번 클릭 (경고 창이 뜨면 "추가 정보 → 실행")</li>
            <li>열린 창에서 한 번만 로그인하면 됩니다</li>
          </ol>
        </section>
      )}

      <section className="card">
        {snap.armed ? (
          <>
            <h2>{snap.mode === 'live' ? '자동 방송 진행 중' : '테스트 방송 진행 중'}</h2>
            <p className="muted">
              창을 닫거나 PC를 끄지 마세요. 다른 프로그램을 써도 방송은 계속됩니다. 실수로 닫았다면 다시 열면 이어서 진행합니다.
            </p>
            <div className="row">
              <button className="danger big" onClick={() => player.stopAll()}>
                ■ 지금 나오는 소리 정지
              </button>
              <button onClick={stopAuto}>자동 방송 중지</button>
            </div>
          </>
        ) : armedToday ? (
          <>
            <h2>{armedToday.label}</h2>
            {stoppedToday ? (
              <>
                <p>담당자가 자동 방송을 중지했습니다. 다시 시작하면 남은 방송부터 이어서 진행합니다.</p>
                <button className="primary huge" disabled={!loaded} onClick={restartToday}>
                  ▶ 자동 방송 다시 시작
                </button>
              </>
            ) : (
              <p>준비가 끝나면 자동으로 시작됩니다…</p>
            )}
          </>
        ) : (
          <>
            <h2>테스트 / 리허설</h2>
            <p className="muted">
              오늘은 방송일이 아니므로 연습만 할 수 있습니다. {nextArmed && `${nextArmed.date} (${nextArmed.label})에는 화면을 열어 두기만 하면 자동으로 방송합니다.`}
            </p>
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
              <button className="primary" disabled={!loaded || inLockWindow} onClick={() => void startRehearsal(false)}>
                ▶ 리허설 시작
              </button>
              <button disabled={!loaded || inLockWindow} onClick={() => void startRehearsal(true)}>
                오늘 실제 시각으로 테스트
              </button>
            </div>
          </>
        )}
        {inLockWindow && !snap.armed && <p className="error">수능 당일 운영 시간에는 테스트 기능이 잠겨 있습니다.</p>}
      </section>

      <section className="card">
        <h2>오늘 시간표</h2>
        <p className="muted small">자동 방송이 안 나갔을 때는 해당 줄의 [지금 재생]을 누르면 즉시 송출됩니다.</p>
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

function summarize(s: {
  armed: boolean;
  mode: string;
  audioOn: boolean;
  alarms: string[];
  loaded: boolean;
  assetsReady: boolean;
  clockUsable: boolean;
  armedTodayLabel?: string;
  stoppedToday: boolean;
  next: string | null;
}): { level: 'ok' | 'warn' | 'bad' | 'idle'; title: string; detail?: string } {
  if (s.armed && !s.audioOn) return { level: 'bad', title: '소리가 꺼져 있습니다 — 화면을 한 번 클릭하세요' };
  if (s.armed && s.alarms.length) return { level: 'bad', title: s.alarms[0] };
  if (s.armed) {
    const label = s.mode === 'live' ? '자동 방송 중' : '테스트 방송 중';
    const issues = [!s.assetsReady && '일부 음원 없음', !s.clockUsable && '서버 시각 미확인'].filter(Boolean);
    return {
      level: issues.length ? 'warn' : 'ok',
      title: `✅ ${label} — 그대로 두시면 됩니다`,
      detail: [s.next ? `다음: ${s.next}` : '오늘 방송 모두 완료', ...issues].join(' · '),
    };
  }
  if (s.armedTodayLabel && s.stoppedToday) return { level: 'warn', title: '자동 방송이 중지된 상태입니다', detail: '아래 [자동 방송 다시 시작]을 누르세요' };
  if (s.armedTodayLabel && !s.loaded) return { level: 'idle', title: '방송 준비 중… 잠시만 기다리세요' };
  return { level: 'idle', title: '방송 준비 상태를 점검하세요', detail: '방송일에는 이 화면을 열어 두기만 하면 자동으로 방송합니다' };
}

/** 개발용 시뮬레이션 시작 시각 (새로고침해도 같은 시각을 유지해야 이어하기를 시험할 수 있음) */
function devStartAt(): number {
  const KEY = 'csat-cast:dev-start';
  const saved = Number(localStorage.getItem(KEY));
  if (saved && Math.abs(saved - serverClock.now()) < 60 * 60_000) return saved;
  const start = serverClock.now() + 20_000;
  localStorage.setItem(KEY, String(start));
  return start;
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
