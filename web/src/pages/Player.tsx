import CampaignIcon from '@mui/icons-material/CampaignOutlined';
import EditCalendarIcon from '@mui/icons-material/EditCalendarOutlined';
import ScienceIcon from '@mui/icons-material/ScienceOutlined';
import { Chip, MenuItem, TextField, Typography } from '@mui/material';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import AppShell, { type NavItem } from '../components/AppShell';
import { useSearchParams } from 'react-router-dom';
import { audioEngine, type LoadResult } from '../core/audio';
import { doc, onSnapshot } from 'firebase/firestore';
import { defaultProfile } from '../core/catalog';
import { fb, usingEmulator } from '../core/firebase';
import { cuesHash, devicesConflict, devicesOpen, toTimeline, type DevicePresence } from '../core/board';
import {
  loadBuiltinAssets,
  loadGlobalConfig,
  loadSchool,
  loadSchoolAssets,
  loadTemplates,
} from '../core/catalog';
import { OS_DRIFT_WARN_MS, serverClock, type ClockStatus } from '../core/clock';
import { ISSUE_LABEL, player, type PlayerSnapshot } from '../core/player';
import { deviceId, startPresence, watchPresence } from '../core/presence';
import { HEARTBEAT_MS, Reporter } from '../core/reporter';
import { describeRehearsal, loadRehearsals, rehearsalPlan, saveRehearsals, type ScheduledRehearsal } from '../core/rehearsals';
import { loadRun, saveRun } from '../core/runStore';
import { buildPlan, kstDate, kstEpoch, kstTime, resolveCues, shiftPlan, type CueState } from '../core/scheduler';
import type { Asset, GlobalConfig, SchoolProfile, Template } from '../core/types';
import { onUpdatePending } from '../core/updates';
import { useSession } from '../session';
import NowPlayingDetail, { formatDuration, useNowPlaying } from './NowPlaying';
import RehearsalScheduler, { shortDate } from './RehearsalScheduler';
import ScheduleEditor from './ScheduleEditor';
import RunReports from './RunReports';
import { clearReports, incidentsFrom, loadReports, outcomesFrom, saveReport, uploadReport, type RunReport } from '../core/runReports';
import { LOW_BATTERY, powerText, usePower } from '../core/power';
import { useAudioOutput } from '../core/audioOutput';

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
  /** 음원 파일 확인 진행 상황 ([확인한 수, 전체]) — 끝나면 'done' */
  const [verify, setVerify] = useState<[number, number] | 'done' | null>(null);
  const [clock, setClock] = useState<ClockStatus>(serverClock.getStatus());
  const [snap, setSnap] = useState<PlayerSnapshot>(player.snapshot());
  const [now, setNow] = useState(serverClock.now());
  const [unlocked, setUnlocked] = useState(audioEngine.unlocked);
  const [autoplayAllowed, setAutoplayAllowed] = useState(false);
  const [wakeLock, setWakeLock] = useState(false);
  /** 방송 화면이 가려졌는가 (창 최소화·다른 탭) — 가려지면 화면 꺼짐 방지가 풀린다 */
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  const power = usePower();
  /** 방송 소리 출력 장치 (앰프 쪽 장치로만 보내 다른 소리가 섞이지 않게) */
  const output = useAudioOutput();
  /** 대기 중 출력 쉬기 (이 PC에 기억) */
  const [idleRest, setIdleRestState] = useState(loadIdleRest);
  useEffect(() => player.setIdleRest(idleRest), [idleRest]);
  /** 이 PC의 방송 회차별 결과 기록 */
  const [reports, setReports] = useState<RunReport[]>([]);
  const reportRef = useRef<RunReport | null>(null);
  const prevArmedRef = useRef(false);
  /** 지금 시작하는 방송의 이름 (결과 기록용) */
  const runLabelRef = useRef<string | null>(null);
  /** 결과 기록을 서버에 마지막으로 올린 시각·회차 (진행 중에는 15초에 한 번만) */
  const uploadedRef = useRef<{ id: string; at: number; ended: boolean } | null>(null);
  const [volume, setVolume] = useState(1);
  const [delaySec, setDelaySec] = useState(10);
  const [speed, setSpeed] = useState(1);
  const [sound, setSound] = useState<SoundCheck>('unknown');
  const [tonePlayed, setTonePlayed] = useState(false);
  const [updatePending, setUpdatePending] = useState(false);
  /** 같은 채널을 다른 탭에서 이미 열었는가 (이중 송출 방지) */
  const [duplicateTab, setDuplicateTab] = useState(false);
  /** 이 PC에 예약된 리허설 (학교·채널별) */
  const [rehearsals, setRehearsals] = useState<ScheduledRehearsal[]>([]);
  /** 화면 탭: 실전 방송 / 테스트·리허설 / 시간표 편집 */
  const [tab, setTab] = useState<'live' | 'test' | 'edit'>('live');
  /** 서버에 저장된 최신 학교 설정 (다른 PC에서 바꾼 것을 알아채기 위함) */
  const [remoteProfile, setRemoteProfile] = useState<SchoolProfile | null>(null);
  const [remoteNote, setRemoteNote] = useState<string | null>(null);
  const reporterRef = useRef<Reporter | null>(null);
  const presenceRef = useRef<ReturnType<typeof startPresence> | null>(null);
  /** 같은 채널을 연 PC들 (다른 PC에서도 열었으면 이중 송출 위험) */
  const [devices, setDevices] = useState<Record<string, DevicePresence>>({});

  const channelId = params.get('channel') ?? profile?.channels[0]?.id ?? 'main';
  const channel = profile?.channels.find((c) => c.id === channelId) ?? profile?.channels[0];
  const template = templates.find((t) => t.id === channel?.templateId);
  /** 같은 채널 화면을 연 다른 PC (같은 학교의 다른 담당자 등) */
  const otherDevices = devicesOpen(Object.fromEntries(Object.entries(devices).filter(([id]) => id !== deviceId())));
  /** 서버의 학교 설정이 이 PC가 쓰는 것과 다름 (다른 PC에서 시간표 저장·관리자 유형 변경) */
  const remoteChanged =
    !!remoteProfile && !!profile && stableJson(remoteProfile.channels) !== stableJson(profile.channels);
  /** 학교가 직접 만든 시간표로 방송하는가 (평가원 유형 대신) */
  const custom = !!channel?.customCues;
  const cues = useMemo(() => resolveCues(template, channel), [template, channel]);
  const planHash = useMemo(() => cuesHash(cues), [cues]);

  const today = kstDate(now);
  const nowPlaying = useNowPlaying();
  const tableScrollRef = useRef<HTMLDivElement>(null);
  /** 실제 시간표 기준 각 큐의 시작 시각과 다음 큐 시작 시각 (리허설 배속과 무관하게 겹침 판단) */
  const realSlots = useMemo(() => {
    const plan = buildPlan(cues, today);
    return new Map(plan.map((p, i) => [p.cue.id, { at: p.at, nextAt: plan[i + 1]?.at }]));
  }, [cues, today]);
  // 개발 서버 전용: ?devArmed=1 이면 오늘을 방송일로 가정하고 시간표를 '곧 시작, 60배속'으로 당겨 자동 시작·이어하기를 시험
  const devArmed = import.meta.env.DEV && params.get('devArmed') === '1';
  // 자동 방송하는 날: 교육지원청 지정일(실전·공식 리허설)이 우선, 그다음 학교가 예약한 리허설
  const officialToday = cfg?.armedDates.find((d) => d.date === today);
  const rehearsalToday = officialToday ? undefined : rehearsals.find((r) => r.date === today);
  const armedToday =
    officialToday ??
    (rehearsalToday ? { date: today, mode: 'test' as const, label: `예약 리허설 · ${describeRehearsal(rehearsalToday)}` } : undefined) ??
    (devArmed ? { date: today, mode: 'test' as const, label: '[개발] 방송일 시뮬레이션' } : undefined);
  const todayPlan = () =>
    officialToday
      ? buildPlan(cues, today)
      : rehearsalToday
        ? rehearsalPlan(cues, rehearsalToday)
        : devArmed
          ? shiftPlan(buildPlan(cues, today), devStartAt(), 60)
          : buildPlan(cues, today);
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
        // 에뮬레이터 시험 중에는 Storage 대신 개발 PC의 음원을 쓴다
        loadBuiltinAssets(neisCode !== 'LOCAL' && !usingEmulator).catch(() => []),
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
    let cancelled = false;
    setLoadResult(null);
    setVerify(null);
    void (async () => {
      const r = await audioEngine.load(list, (d, t) => setProgress([d, t]));
      if (cancelled) return;
      const failed = [...r.failed, ...missing.map((id) => ({ id, error: '음원 미등록' }))];
      // 내려받기만 끝나면 방송을 시작할 수 있게 먼저 알린다 (새로고침 직후 곧 울릴 방송을 놓치지 않도록)
      setLoadResult({ loaded: r.loaded, failed });
      // 이어서 파일이 정상인지 하나씩 확인 (메모리를 아끼려 확인 후 바로 버림)
      const broken = await audioEngine.verify(r.loaded, (d, t) => !cancelled && setVerify([d, t]));
      if (cancelled) return;
      setVerify('done');
      if (broken.length)
        setLoadResult({ loaded: r.loaded.filter((id) => !broken.some((b) => b.id === id)), failed: [...failed, ...broken] });
    })();
    return () => {
      cancelled = true;
    };
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
    // 채널 설정 내용이 바뀌어도(시간표 저장 등) 잠금을 다시 잡지 않는다: 놓았다 다시 잡는 사이 "다른 탭에서 열림"으로 잠깐 바뀐다
  }, [neisCode, channel?.id]);

  // 5) 서버 보고 (채널별 실시간 상태)
  useEffect(() => {
    // 로컬 모드는 서버 계정이 없어 보고할 곳이 없다 (보고하면 권한 오류만 반복됨)
    if (!profile || !channel || neisCode === 'LOCAL') return;
    const r = new Reporter(neisCode, channel.id);
    reporterRef.current = r;
    player.reporter = r;

    r.start();
    // 새 보고기에는 방송별 진행 상태를 바로 다시 보낸다 (채널을 바꾸거나 다시 연 경우)
    const s0 = player.snapshot();
    const tl0 = s0.armed && s0.mode !== 'idle' ? toTimeline(s0.plan, s0.states, s0.startedAt, s0.manual, s0.issues) : null;
    timelineSent.current = JSON.stringify(tl0);
    r.update({ timeline: tl0 });
    const u = session.user;
    const pr = u ? startPresence(neisCode, channel.id, { uid: u.uid, email: u.email ?? '', name: u.displayName ?? '' }) : null;
    presenceRef.current = pr;
    const unwatch = watchPresence(neisCode, channel.id, setDevices);
    return () => {
      r.stop();
      pr?.stop();
      unwatch();
      presenceRef.current = null;
      setDevices({});
      if (player.reporter === r) player.reporter = null;
    };
    // 채널 설정 내용(시간표 저장 등)이 바뀔 때마다 보고를 다시 시작하지 않도록 채널 id 기준
  }, [neisCode, !!profile, channel?.id]);

  // 5-1) 다른 PC(같은 학교의 다른 담당자)가 저장한 시간표·설정을 따라간다.
  //      방송 대기 중이 아니면 바로 반영하고, 자동 방송 중이면 멈춘 뒤 반영한다 (진행 중인 방송 계획은 바꾸지 않음).
  useEffect(() => {
    if (!fb || neisCode === 'LOCAL' || !profile) return;
    return onSnapshot(
      doc(fb.db, 'schools', neisCode),
      (d) => {
        if (d.exists()) setRemoteProfile({ ...defaultProfile(neisCode), ...(d.data() as Partial<SchoolProfile>), neisCode });
      },
      () => undefined,
    );
  }, [neisCode, !!profile]);
  useEffect(() => {
    if (!remoteChanged || snap.armed || !remoteProfile) return;
    let cancelled = false;
    void loadSchoolAssets(neisCode).then((s) => {
      if (cancelled) return;
      setAssets((a) => [...a.filter((x) => x.source === 'builtin'), ...s]);
      setProfile(remoteProfile);
      setRemoteNote(`다른 PC에서 저장한 학교 시간표·설정을 불러왔습니다 (${kstTime(serverClock.now())}).`);
    });
    return () => {
      cancelled = true;
    };
  }, [remoteChanged, snap.armed]);

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
  const verifying = loaded && verify !== 'done';
  const assetsReady = loaded && !verifying && loadResult.failed.length === 0 && cues.length > 0;
  const clockUsable = clock.synced || clock.source === 'cached';
  const osDriftWarn = clockUsable && Math.abs(clock.osClockDriftMs) > OS_DRIFT_WARN_MS;
  const next = snap.plan.length ? player.next() : undefined;

  // 시간표가 따로 스크롤되는 넓은 화면에서, 재생 중이거나 다음 방송인 줄이 바뀌면 그 줄이 보이게 옮긴다
  // (바뀔 때만 움직여 담당자가 시간표를 둘러보는 것을 방해하지 않음)
  const playingCueId = cues.find((c) => nowPlaying.some((p) => p.assetId === c.assetId))?.id;
  const focusCueId = playingCueId ?? next?.cue.id;
  useEffect(() => {
    const box = tableScrollRef.current;
    if (!box || !focusCueId || box.scrollHeight <= box.clientHeight) return;
    const row = box.querySelector<HTMLElement>(`tr[data-cue="${focusCueId}"]`);
    if (!row) return;
    const head = box.querySelector('thead')?.clientHeight ?? 0;
    const top = row.offsetTop - head;
    const fullyVisible = top >= box.scrollTop && row.offsetTop + row.offsetHeight * 3 <= box.scrollTop + box.clientHeight;
    if (!fullyVisible) box.scrollTo({ top: Math.max(0, top - box.clientHeight / 4), behavior: 'smooth' });
  }, [focusCueId]);
  // 오늘 자동 방송의 정체 (같은 날 다른 방송의 이어하기 기록을 이어받지 않도록 기록에 함께 저장)
  const planKey = armedToday ? `${armedToday.mode}|${armedToday.label}` : undefined;
  /** 지금 진행 중인 날짜 자동 방송의 planKey (기록 저장용) */
  const runKeyRef = useRef<string | undefined>(undefined);
  const savedRun = channel ? loadRun(neisCode, channel.id, today, planKey) : null;
  const stoppedToday = savedRun?.stoppedByUser ?? false;
  const runningToday = snap.armed && snap.runDate === today;

  // 7) 실제 방송일(실전·공식 리허설)에는 화면을 열기만 하면 자동으로 시작/이어서 진행
  useEffect(() => {
    if (!armedToday || !channel || !loaded || cues.length === 0 || duplicateTab) return;
    if (runningToday || stoppedToday) return;
    // 방송일 화면에서는 리허설을 시작할 수 없으므로, 돌고 있는 리허설은 전날 켜 둔 것 → 실제 방송으로 교체
    const saved = loadRun(neisCode, channel.id, today, planKey);
    runKeyRef.current = planKey;
    player.arm(todayPlan(), armedToday.mode, {
      restore: saved?.states,
      starts: saved?.starts,
      examDelays: saved?.examDelays,
      issues: saved?.issues,
      date: today,
    });
  }, [armedToday?.date, armedToday?.label, channel, loaded, cues, duplicateTab, runningToday, stoppedToday, neisCode, today]);

  // 이 PC에 저장된 리허설 예약 불러오기
  useEffect(() => {
    if (channel) setRehearsals(loadRehearsals(neisCode, channel.id));
  }, [neisCode, channel?.id]);

  // 방송이 시작되면 그 종류에 맞는 탭으로 (테스트 방송 → 테스트 탭, 실전 → 실전 탭)
  useEffect(() => {
    if (snap.armed && snap.mode !== 'idle') setTab(snap.mode);
  }, [snap.armed, snap.mode]);

  // 8) 진행 상태를 PC에 저장 (새로고침·재시작 후 이어하기)
  useEffect(() => {
    if (!channel || !snap.runDate || snap.mode === 'idle') return;
    saveRun(neisCode, channel.id, {
      date: snap.runDate,
      mode: snap.mode,
      states: snap.states,
      starts: snap.starts,
      examDelays: snap.examDelays,
      issues: snap.issues,
      stoppedByUser: false,
      savedAt: Date.now(),
      planKey: runKeyRef.current ?? (snap.runDate === today ? planKey : undefined),
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
        operator: session.operator,
        deviceId: deviceId(),
        planHash,
        runDate: s.runDate,
        wakeLock,
        hidden,
        audioOutput: { label: output.choice?.label ?? '윈도우 기본 장치', level: output.status.level },
        power: power.level === null ? null : { level: Math.round(power.level * 100) / 100, charging: power.charging },
      });
    };
    send();
    const id = setInterval(send, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [profile, channel, assetsReady, loadResult, unlocked, autoplayAllowed, sound, snap.armed, snap.mode, snap.alarms.length, next?.cue.id, clock.synced, clock.source, planHash, wakeLock, hidden, output.status.level, output.choice?.deviceId, power.charging, power.level !== null && power.level < LOW_BATTERY]);

  // 10-1) 방송별 진행 상태를 보고 (관리자 화면의 학교 × 방송 표). 바뀔 때만 보낸다.
  const timelineSent = useRef('');
  useEffect(() => {
    const r = reporterRef.current;
    if (!r) return;
    const timeline = snap.armed && snap.mode !== 'idle' ? toTimeline(snap.plan, snap.states, snap.startedAt, snap.manual, snap.issues) : null;
    const key = JSON.stringify(timeline);
    if (key === timelineSent.current) return;
    timelineSent.current = key;
    r.update({ timeline });
    presenceRef.current?.setArmed(snap.armed);
  }, [snap]);

  // 화면 꺼짐 방지: 방송 화면이 열려 있는 동안은 항상 (방송 시작 전 대기 중에 노트북·태블릿이 잠들지 않게).
  // 창을 최소화하거나 다른 탭으로 가면 브라우저가 풀어 버리므로, 다시 보이면 곧바로 재요청한다.
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    let alive = true;
    const acquire = async () => {
      if (document.visibilityState !== 'visible' || (lock && !lock.released)) return;
      try {
        lock = await navigator.wakeLock.request('screen');
        if (!alive) return void lock.release();
        setWakeLock(true);
        lock.addEventListener('release', () => setWakeLock(false));
      } catch {
        setWakeLock(false);
      }
    };
    void acquire();
    const onVis = () => {
      setHidden(document.visibilityState === 'hidden');
      void acquire();
    };
    document.addEventListener('visibilitychange', onVis);
    // 드물게 브라우저가 이유 없이 풀어 버리는 경우 대비
    const retry = setInterval(() => void acquire(), 30_000);
    return () => {
      alive = false;
      clearInterval(retry);
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release();
    };
  }, []);

  // 자동 방송 중 실수로 창 닫기 방지
  useEffect(() => {
    if (!snap.armed) return;
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [snap.armed]);

  // 방송 결과 기록: 자동 방송이 시작되면 회차를 만들고, 진행하는 동안 방송별 결과·사고를 갱신, 멈추면 마감
  useEffect(() => {
    if (channel) setReports(loadReports(neisCode, channel.id));
  }, [neisCode, channel?.id]);
  useEffect(() => {
    if (!channel) return;
    const rose = snap.armed && !prevArmedRef.current;
    prevArmedRef.current = snap.armed;
    let r = reportRef.current;
    if (snap.armed && snap.mode !== 'idle') {
      if (rose || !r) {
        // 새로고침·재시작으로 이어서 진행하는 경우는 같은 회차를 이어 쓴다
        const last = loadReports(neisCode, channel.id)[0];
        const resumed = last && last.endedAt === null && last.mode === snap.mode && kstDate(last.startedAt) === kstDate(serverClock.now());
        r = resumed
          ? last
          : {
              id: String(Date.now()),
              mode: snap.mode,
              label:
                (armedToday && snap.runDate === today ? armedToday.label : null) ??
                runLabelRef.current ??
                (snap.mode === 'live' ? '실전 방송' : '테스트 방송'),
              startedAt: serverClock.now(),
              endedAt: null,
              cues: [],
              incidents: [],
              battery: { min: null, unplugged: false },
            };
        runLabelRef.current = null;
      }
      r = { ...r, cues: outcomesFrom(snap, false), incidents: incidentsFrom(snap.events, r.startedAt, r.incidents) };
    } else if (r && r.endedAt === null) {
      r = {
        ...r,
        endedAt: serverClock.now(),
        cues: outcomesFrom(snap, true, player.wasStoppedByUser),
        incidents: incidentsFrom(snap.events, r.startedAt, r.incidents),
      };
    } else return;
    reportRef.current = r;
    setReports(saveReport(neisCode, channel.id, r));
    syncReport(r);
  }, [snap, channel?.id]);

  /** 관리자 화면용으로 서버에 올린다: 새 회차·마감은 바로, 진행 중에는 15초에 한 번 */
  function syncReport(r: RunReport, force = false) {
    if (!channel || !profile) return;
    const u = uploadedRef.current;
    const ended = r.endedAt !== null;
    if (!force && u && u.id === r.id && u.ended === ended && Date.now() - u.at < 15_000) return;
    uploadedRef.current = { id: r.id, at: Date.now(), ended };
    uploadReport(r, { school: neisCode, channel: channel.id, schoolName: profile.name, channelLabel: channel.label, operator: session.operator });
  }

  /** 방송 중 생긴 PC 환경 문제(화면 가려짐·전원 분리 등)를 이 회차 기록에 남긴다 */
  function addIncident(message: string, level: 'warn' | 'error' = 'warn') {
    const r = reportRef.current;
    if (!channel || !r || r.endedAt !== null || !player.armed) return;
    const next = { ...r, incidents: [...r.incidents, { at: serverClock.now(), level, message }] };
    reportRef.current = next;
    setReports(saveReport(neisCode, channel.id, next));
    syncReport(next, true);
  }
  useEffect(() => {
    if (hidden) addIncident('방송 화면이 가려짐 (창 최소화·다른 탭) — 화면 꺼짐 방지가 풀립니다');
  }, [hidden]);
  useEffect(() => {
    // 창을 가려서 풀린 경우는 위의 '화면 가려짐'으로 이미 남긴다
    if (!wakeLock && document.visibilityState === 'visible' && snap.armed && 'wakeLock' in navigator) addIncident('화면 꺼짐 방지가 풀림');
  }, [wakeLock]);
  useEffect(() => {
    const r = reportRef.current;
    if (!channel || !r || r.endedAt !== null || power.level === null) return;
    const unplugged = power.charging === false;
    const min = r.battery?.min == null ? power.level : Math.min(r.battery.min, power.level);
    if (unplugged && !r.battery?.unplugged) addIncident(`전원 어댑터 분리됨 (배터리 ${Math.round(power.level * 100)}%)`, 'error');
    const cur = reportRef.current!;
    const next = { ...cur, battery: { min, unplugged: unplugged || !!cur.battery?.unplugged } };
    reportRef.current = next;
    setReports(saveReport(neisCode, channel.id, next));
  }, [power.level, power.charging]);

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
    runKeyRef.current = planKey;
    player.arm(todayPlan(), armedToday.mode, {
      restore: savedRun?.states,
      starts: savedRun?.starts,
      examDelays: savedRun?.examDelays,
      issues: savedRun?.issues,
      date: today,
    });
  }

  function stopAuto() {
    // 실전 중지는 실수 방지를 위해 한 번 더 확인
    if (snap.mode === 'live' && !window.confirm('실전 자동 방송을 중지할까요? 이후 방송은 직접 해야 합니다.')) return;
    const runDate = snap.runDate;
    player.disarm(true);
    // 중지하면서 끊긴 방송의 판정까지 담기도록 중지 뒤 상태로 저장
    const after = player.snapshot();
    if (runDate && channel) {
      saveRun(neisCode, channel.id, {
        date: runDate,
        mode: snap.mode === 'idle' ? 'test' : snap.mode,
        states: after.states,
        starts: snap.starts,
        examDelays: snap.examDelays,
        issues: after.issues,
        stoppedByUser: true,
        savedAt: Date.now(),
        planKey: runKeyRef.current ?? (snap.runDate === today ? planKey : undefined),
      });
    }
  }

  function updateRehearsals(list: ScheduledRehearsal[]) {
    if (!channel) return;
    setRehearsals(list);
    saveRehearsals(neisCode, channel.id, list);
  }

  async function startRehearsal(realTime: boolean) {
    await unlockAudio();
    const base = buildPlan(cues, today);
    runLabelRef.current = realTime ? '오늘 실제 시각으로 테스트' : `바로 리허설 ${speed}배속`;
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
    assetsChecking: verifying && !!loadResult && loadResult.failed.length === 0,
    clockUsable,
    armedTodayLabel: armedToday?.label,
    stoppedToday,
    next: next ? `${kstTime(next.at)} ${next.cue.label}` : null,
  });

  const nextLive = cfg.armedDates
    .filter((d) => d.mode === 'live' && d.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  const upcomingRehearsals = rehearsals.filter((r) => r.date >= today).length;

  // 자동 방송 진행 중 제어 (실전·테스트 탭 공통)
  const runningControls = (
    <>
      <h2>{snap.mode === 'live' ? '자동 방송 진행 중' : '테스트 방송 진행 중'}</h2>
      {snap.mode === 'test' && armedToday?.mode === 'test' && snap.runDate === today && <p>{armedToday.label}</p>}
      <p className="muted">
        창을 닫거나 PC를 끄지 마세요. 다른 프로그램을 써도 방송은 계속됩니다. 실수로 닫았다면 다시 열면 이어서 진행합니다.
      </p>
      <div className="row">
        <button className="danger big" onClick={() => player.stopAll()}>
          ■ 지금 나오는 소리 정지
        </button>
        <button onClick={stopAuto}>자동 방송 중지</button>
      </div>
      <ExamDelayControl />
    </>
  );

  // 오늘이 자동 방송일(실전·공식 리허설·예약 리허설)인데 아직 진행 중이 아닐 때
  const todayControls = armedToday && (
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
  );

  const checks: { ok: boolean; warn?: boolean; label: string; detail: string }[] = [
    {
      ok: assetsReady,
      warn: verifying && loadResult.failed.length === 0,
      label: '음원',
      detail: loadResult
        ? loadResult.failed.length
          ? `${loadResult.failed.length}개 준비 실패 (해당 방송은 직접 하셔야 합니다): ${loadResult.failed.map((f) => f.id).join(', ')}`
          : verifying
            ? `${loadResult.loaded.length}개 내려받음 · 파일 확인 중 ${Array.isArray(verify) ? `${verify[0]}/${verify[1]}` : ''}`
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
      detail: unlocked
        ? (autoplayAllowed ? '켜짐 (자동)' : '켜짐') + (snap.outputResting ? ' · 대기 중 출력 쉼 (다음 방송 60초 전에 다시 켜짐)' : '')
        : '꺼짐 — 화면 아무 곳이나 한 번 클릭하세요',
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
      ok: wakeLock,
      warn: !wakeLock && !snap.armed,
      label: '화면 꺼짐 방지',
      detail: wakeLock
        ? '켜짐 — 이 화면이 열려 있는 동안 화면이 꺼지거나 절전으로 들어가지 않습니다 (창을 최소화하면 풀림)'
        : hidden
          ? '꺼짐 — 방송 화면이 가려져 있습니다. 창을 최소화하지 말고 앞에 띄워 두세요'
          : '이 기기·브라우저에서 지원 안 됨 — 아래 [절전 설정 방법]대로 기기 설정을 바꾸세요',
    },
    {
      ok: output.status.level === 'ok',
      warn: output.status.level === 'warn',
      label: '출력 장치',
      detail: output.status.text,
    },
    {
      ok: power.charging === true,
      warn: power.charging !== true && !(power.level !== null && power.level < LOW_BATTERY && power.charging === false),
      label: '전원',
      detail: powerText(power),
    },
  ];

  const nav: NavItem<typeof tab>[] = [
    {
      key: 'live',
      label: '실전 방송',
      icon: <CampaignIcon fontSize="small" />,
      badge: liveDay ? { label: '오늘', color: 'error' } : undefined,
    },
    {
      key: 'test',
      label: '테스트 · 리허설',
      icon: <ScienceIcon fontSize="small" />,
      badge:
        snap.armed && snap.mode === 'test'
          ? { label: '진행 중', color: 'warning' }
          : upcomingRehearsals > 0
            ? { label: `예약 ${upcomingRehearsals}` }
            : undefined,
    },
    {
      key: 'edit',
      label: '시간표 편집',
      icon: <EditCalendarIcon fontSize="small" />,
      badge: custom ? { label: '학교', color: 'primary' } : undefined,
    },
  ];

  return (
    <AppShell<typeof tab>
      fill
      subtitle={profile.name}
      nav={nav}
      active={tab}
      onSelect={setTab}
      title={profile.name}
      status={
        <>
          {profile.channels.length > 1 ? (
            <TextField
              select
              size="small"
              value={channel?.id ?? ''}
              onChange={(e) => setParams({ channel: e.target.value })}
              disabled={snap.armed}
              sx={{ minWidth: 160 }}
            >
              {profile.channels.map((c) => (
                <MenuItem key={c.id} value={c.id}>
                  {c.label}
                </MenuItem>
              ))}
            </TextField>
          ) : (
            <Chip size="small" variant="outlined" label={channel?.label} />
          )}
          <Typography variant="body2" color="text.secondary" noWrap>
            {custom ? '학교 시간표' : template?.name}
          </Typography>
          {session.localMode && <Chip size="small" label="로컬 모드" />}
          {snap.mode !== 'idle' && (
            <Chip size="small" color={snap.mode === 'live' ? 'error' : 'warning'} label={snap.mode === 'live' ? '실전 방송 중' : '테스트 중'} />
          )}
        </>
      }
      operator={session.operator}
      email={session.user?.email}
      onLogout={() => void session.logout()}
      logoutDisabled={snap.armed}
      logoutHint="자동 방송 중에는 로그아웃할 수 없습니다. 방송을 멈춘 뒤 로그아웃하세요."
    >
    <div className="player">
      {snap.armed && !unlocked && (
        <button className="overlay" onClick={() => void unlockAudio()}>
          <span className="overlay-title">🔇 소리가 꺼져 있습니다</span>
          <span>화면을 한 번 클릭하면 방송 소리가 켜집니다</span>
        </button>
      )}


      {/* 시간표 편집에서는 상태 요약·시계 대신 편집 영역을 넓게 쓴다 (중요 경고는 위에 그대로) */}
      <div className={`player-body ${tab === 'edit' ? 'editing' : ''}`}>
        <div className="col-side">
          {tab !== 'edit' && (
            <div className={`headline ${headline.level}`}>
              <div className="headline-title">{headline.title}</div>
              {headline.detail && <div>{headline.detail}</div>}
            </div>
          )}

          {channel && templates.length > 0 && !template && !custom && (
            <div className="banner bad">
              ⛔ 이 시험장에 지정된 시간표({channel.templateId})를 찾을 수 없어 자동 방송을 할 수 없습니다. 교육지원청에 시험장
              유형(안내방송 유형 1~6) 설정을 요청하세요.
              {session.localMode && ' 로컬 모드라면 로그아웃 후 시험장 상황을 다시 골라 시작하세요.'}
            </div>
          )}
          {template && !custom && !template.verified && (
            <div className="banner warn">⚠ 이 시간표는 아직 공식 시간표로 검증되지 않은 초안입니다.</div>
          )}
          {session.authLost && (
            <div className="banner bad">
              ⚠ 서버 로그인이 끊겼습니다 (권한 회수 또는 로그인 만료). 자동 방송은 이 PC에서 그대로 계속되지만 교육지원청으로 보고가 되지 않습니다.
              방송이 모두 끝난 뒤 다시 로그인하세요.
            </div>
          )}
          {devicesConflict(devices).length > 0 ? (
            <div className="banner bad">
              ⛔ 다른 PC에서도 이 방송 채널을 자동 방송 중입니다 (이중 송출 위험). 한 대만 남기고 나머지 PC는 방송을 멈추세요.
              <ul>
                {devicesConflict(devices).map((d, i) => (
                  <li key={i}>
                    {d.name || d.email || d.uid} · {new Date(d.since).toLocaleTimeString('ko-KR')}부터
                    {Object.entries(devices).find(([, v]) => v === d)?.[0] === deviceId() ? ' (이 PC)' : ''}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            otherDevices.length > 0 && (
              <div className="banner">
                다른 PC에서도 이 채널 화면이 열려 있습니다:{' '}
                {otherDevices.map((d) => `${d.name || d.email || d.uid}${d.armed ? '(자동 방송 중)' : ''}`).join(', ')}. 자동 방송은 한
                PC에서만 시작하세요.
              </div>
            )
          )}
          {remoteChanged && snap.armed && (
            <div className="banner warn">
              다른 PC에서 학교 시간표·설정을 바꿨습니다. 지금 진행 중인 방송에는 반영되지 않고, 방송을 멈추면 자동으로 반영됩니다.
            </div>
          )}
          {remoteNote && !remoteChanged && <div className="banner okay">{remoteNote}</div>}
          {updatePending && (
            <div className="banner">새 버전이 준비되어 있습니다. 방송이 끝난 뒤 자동으로 적용됩니다 (방송 중에는 적용하지 않음).</div>
          )}

          {tab !== 'edit' && (
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
          )}

          {(tab === 'live' || tab === 'test') && (
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
              {output.supported && (
                <div className="output-pick">
                  <label className="row">
                    <strong>출력 장치</strong>
                    {output.devices ? (
                      <select value={output.choice?.deviceId ?? ''} onChange={(e) => output.choose(e.target.value)}>
                        <option value="">윈도우 기본 장치</option>
                        {output.devices.map((d) => (
                          <option key={d.deviceId} value={d.deviceId}>
                            {d.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <button className="small" onClick={() => void output.requestList()}>
                        장치 목록 불러오기
                      </button>
                    )}
                  </label>
                  <p className="muted small">
                    방송 앰프에 연결된 장치를 고르면 방송 소리만 그쪽으로 나갑니다. 윈도우 기본 출력은 노트북 스피커로 두면 알림음 등 다른
                    소리가 방송에 섞이지 않습니다. 처음 한 번 '마이크 사용' 허용 창이 뜹니다 (장치 이름 확인용, 마이크는 쓰지 않음). 고른 뒤
                    [테스트 소리]로 확인하세요{snap.armed ? ' · 방송 중에 바꾸면 소리가 잠깐 끊길 수 있습니다' : ''}.
                  </p>
                </div>
              )}
              <div className="output-pick">
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={idleRest}
                    onChange={(e) => {
                      setIdleRestState(e.target.checked);
                      saveIdleRest(e.target.checked);
                    }}
                  />{' '}
                  <strong>대기 중 출력 쉬기</strong> (대기 잡음 줄이기)
                </label>
                <p className="muted small">
                  다음 방송까지 2분 넘게 남으면 오디오 출력을 멈춰, 대기 중 믹서·앰프로 가는 잡음(화이트 노이즈)을 줄입니다. 다음 방송 60초 전에
                  다시 켜고, 켜지지 않으면 경보를 띄웁니다. 처음 쓸 때는 리허설로 먼저 확인하세요
                  {snap.outputResting ? ' · 지금 출력 쉬는 중' : ''}.
                </p>
              </div>
              <details className="power-help">
                <summary>절전·다른 소리 막기 설정 방법 (방송 PC·노트북·태블릿 필수)</summary>
                <p className="muted small">
                  이 화면이 앞에 떠 있으면 화면 꺼짐을 막지만, 덮개를 닫거나 창을 최소화하면 막을 수 없습니다. 방송 전에 기기 설정을 함께
                  바꿔 두세요.
                </p>
                <ul>
                  <li>
                    <strong>Windows 노트북</strong>: 설정 → 시스템 → 전원 → 화면 끄기·절전 모드 "안 함"(전원 연결 시), 제어판 → 전원 옵션 →
                    "덮개를 닫으면" → "아무 것도 안 함"
                  </li>
                  <li>
                    <strong>iPad</strong>: 설정 → 디스플레이 및 밝기 → 자동 잠금 "안 함" (배터리 상태는 화면에서 확인할 수 없으니 충전기를 꼭
                    연결)
                  </li>
                  <li>
                    <strong>안드로이드 태블릿</strong>: 설정 → 디스플레이 → 화면 자동 꺼짐 최대, 절전 모드 끄기
                  </li>
                  <li>
                    <strong>공통</strong>: 전원 어댑터 연결, Windows 업데이트 자동 재시작 미루기, 브라우저 창은 최대화한 채로 두기
                  </li>
                </ul>
                <p className="muted small" style={{ marginTop: 8 }}>
                  <strong>다른 소리 막기</strong> — 알림음·메신저·업데이트 소리가 교실 방송에 섞이지 않게:
                </p>
                <ul>
                  <li>
                    위의 <strong>출력 장치</strong>에서 앰프 쪽 장치를 고르고, 윈도우 기본 출력(작업 표시줄 스피커 아이콘)은 노트북 스피커로
                  </li>
                  <li>설정 → 시스템 → 알림: 알림 끄기 또는 방해 금지 켜기</li>
                  <li>제어판 → 소리 → 소리 탭: 소리 구성표 "소리 없음"</li>
                  <li>볼륨 믹서에서 브라우저 말고 다른 프로그램 볼륨 0, 메신저(쿨메신저·카카오톡 등)·백신 알림 끄기</li>
                  <li>다른 브라우저 탭·동영상 닫기, Windows 업데이트 일시 중지</li>
                </ul>
              </details>
              {sound === 'not-heard' && (
                <ol className="help">
                  <li>방송 앰프 전원과 볼륨, 이 PC와 앰프를 잇는 케이블을 확인하세요.</li>
                  <li>Windows 작업 표시줄 스피커 아이콘에서 음소거가 아닌지 확인하고, 위의 [출력 장치]에서 앰프 쪽 장치를 골랐는지 확인하세요.</li>
                  <li>다시 [테스트 소리]를 눌러 보세요. 그래도 안 되면 교육지원청 담당자에게 연락하세요.</li>
                </ol>
              )}
            </section>
          )}

          {tab === 'live' && !autoplayAllowed && !session.localMode && (
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

          {tab === 'live' && (
            <section className="card">
              {snap.armed && snap.mode === 'live' ? (
                runningControls
              ) : snap.armed ? (
                <>
                  <h2>실전 방송</h2>
                  <p>지금은 테스트 방송이 진행 중입니다. 실전 방송일에는 테스트를 끄지 않아도 실전으로 자동 교체됩니다.</p>
                  <button onClick={() => setTab('test')}>테스트 탭에서 보기</button>
                </>
              ) : armedToday?.mode === 'live' ? (
                todayControls
              ) : (
                <>
                  <h2>실전 방송</h2>
                  {nextLive ? (
                    <p>
                      <strong>
                        {shortDate(nextLive.date)} {nextLive.label}
                      </strong>{' '}
                      <span className="tag live">D-{dday(today, nextLive.date)}</span>
                      <br />그날 이 화면을 열어 두기만 하면 08:05부터 자동으로 방송합니다.
                    </p>
                  ) : (
                    <p className="muted">예정된 실전 방송일이 없습니다.</p>
                  )}
                </>
              )}
            </section>
          )}

          {tab === 'test' && (
            <section className="card">
              {snap.armed && snap.mode === 'test' ? (
                runningControls
              ) : snap.armed ? (
                <>
                  <h2>테스트 / 리허설</h2>
                  <p className="muted">실전 방송 중에는 테스트할 수 없습니다.</p>
                </>
              ) : armedToday?.mode === 'test' ? (
                todayControls
              ) : (
                <>
                  <h2>바로 리허설</h2>
                  <p className="muted">지금 바로 시간표 전체를 연습합니다. 정해진 날에 하려면 아래 [리허설 예약]을 쓰세요.</p>
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
          )}

          {tab === 'test' && cfg && (
            <RehearsalScheduler
              list={rehearsals}
              onChange={updateRehearsals}
              now={now}
              official={cfg.armedDates}
              runningDate={snap.armed && snap.mode === 'test' ? snap.runDate : null}
            />
          )}

          {tab === 'test' && channel && (
            <RunReports
              reports={reports}
              onClear={() => {
                clearReports(neisCode, channel.id);
                reportRef.current = snap.armed ? reportRef.current : null;
                setReports(reportRef.current ? saveReport(neisCode, channel.id, reportRef.current) : []);
              }}
            />
          )}

          {tab !== 'edit' && snap.events.length > 0 && (
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

        <div className="col-main">
          {tab === 'edit' && channel ? (
            <ScheduleEditor
              key={channel.id}
              neisCode={neisCode}
              profile={profile}
              channel={channel}
              template={template}
              assets={assets}
              locked={snap.armed}
              othersArmed={otherDevices.filter((d) => d.armed).map((d) => d.name || d.email || d.uid)}
              onProfile={setProfile}
              onAssets={setAssets}
            />
          ) : (
            <section className="card timetable-card">
              <div className="timetable-head">
                <h2>오늘 시간표</h2>
                <span className="muted small">자동 방송이 안 나갔을 때(건너뜀·실패)는 해당 줄의 [지금 재생]을 누르면 즉시 송출됩니다. 이미 송출한 방송은 다시 누를 수 없습니다.</span>
              </div>
              <div className="table-scroll" ref={tableScrollRef}>
                <table className="timeline">
                  <thead>
                    <tr>
                      <th>시각</th>
                      <th>교시</th>
                      <th>내용</th>
                      <th title="음원 길이 (실제 시간표에서 끝나는 시각)">길이</th>
                      <th>상태</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {(snap.plan.length ? snap.plan : buildPlan(cues, today)).map(({ cue, at }) => {
                      const st = snap.states[cue.id] ?? 'pending';
                      const issue = st === 'done' ? snap.issues[cue.id] : undefined;
                      // 실제로 소리가 나고 있는지는 오디오 엔진 기준 (수동 재생은 자동 송출 상태와 별개라 따로 확인)
                      const sounding = nowPlaying.find((p) => p.assetId === cue.assetId);
                      return (
                        <Fragment key={cue.id}>
                          <tr
                            data-cue={cue.id}
                            className={`st-${sounding ? 'playing' : st} ${next?.cue.id === cue.id ? 'is-next' : ''}`}
                          >
                            <td className="mono">
                              {kstTime(at)}
                              {snap.delays[cue.id] && (
                                <span className="tag delay" title="본령이 늦게 울려 시험 시간을 보장하려고 늦춘 시각">
                                  +{formatDuration(snap.delays[cue.id] / 1000)}
                                </span>
                              )}
                            </td>
                            <td>{cue.period}</td>
                            <td>
                              {cue.kind === 'bell' ? '🔔 ' : '📢 '}
                              {cue.label}
                              {!cue.official && !custom && <span className="tag">학교 추가</span>}
                            </td>
                            <DurationCell ms={audioEngine.durationMs(cue.assetId)} slot={realSlots.get(cue.id)} />
                            <td>
                              {sounding ? (
                                <span className="mono">
                                  ▶ 재생 중 {formatDuration(sounding.positionSec)} / {formatDuration(sounding.durationSec)}
                                </span>
                              ) : snap.plan.length ? (
                                issue ? (
                                  <span className={issue.kind === 'stopped' ? 'issue-warn' : 'issue-bad'} title={issue.detail}>
                                    {ISSUE_LABEL[issue.kind]}
                                    <small> {issue.detail}</small>
                                  </span>
                                ) : (
                                  STATE_LABEL[st]
                                )
                              ) : (
                                ''
                              )}
                            </td>
                            <td>
                              {sounding ? (
                                <button
                                  className="small danger"
                                  onClick={() => (snap.plan.length ? player.stopCue(cue.id) : audioEngine.stopAsset(cue.assetId))}
                                  title="이 음원 재생 정지 (끝까지 안 나간 방송은 '담당자 정지'로 기록)"
                                >
                                  ■ 정지
                                </button>
                              ) : snap.plan.length && (st === 'done' || st === 'playing' || st === 'scheduled') ? (
                                // 이미 송출했거나 곧 나갈 방송은 다시 누를 수 없다 (실전·테스트 모두, 같은 안내 두 번 송출 방지)
                                <button className="small" disabled title={st === 'done' ? '이미 송출한 방송입니다' : '곧 자동으로 송출됩니다'}>
                                  {st === 'done' ? (issue ? '송출함 (끊김)' : '✓ 송출 완료') : '곧 송출'}
                                </button>
                              ) : (
                                <button
                                  className="small"
                                  disabled={!audioEngine.has(cue.assetId)}
                                  onClick={async () => {
                                    await unlockAudio();
                                    if (snap.plan.length) await player.playNow(cue.id);
                                    else {
                                      const h = await audioEngine.playNow(cue.assetId).catch(() => null);
                                      void h?.ended.then(() => audioEngine.release(cue.assetId));
                                    }
                                  }}
                                  title="이 방송을 지금 즉시 재생"
                                >
                                  ▶ 지금 재생
                                </button>
                              )}
                            </td>
                          </tr>
                          {sounding && (
                            <tr className="np-row">
                              <td colSpan={6}>
                                <NowPlayingDetail p={sounding} />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
    </AppShell>
  );
}

function summarize(s: {
  armed: boolean;
  mode: string;
  audioOn: boolean;
  alarms: string[];
  loaded: boolean;
  assetsReady: boolean;
  /** 내려받기는 끝났고 파일 확인 중 (아직 문제 없음) */
  assetsChecking: boolean;
  clockUsable: boolean;
  armedTodayLabel?: string;
  stoppedToday: boolean;
  next: string | null;
}): { level: 'ok' | 'warn' | 'bad' | 'idle'; title: string; detail?: string } {
  if (s.armed && !s.audioOn) return { level: 'bad', title: '소리가 꺼져 있습니다 — 화면을 한 번 클릭하세요' };
  if (s.armed && s.alarms.length) return { level: 'bad', title: s.alarms[0] };
  if (s.armed) {
    const label = s.mode === 'live' ? '자동 방송 중' : '테스트 방송 중';
    const issues = [!s.assetsReady && (s.assetsChecking ? '음원 확인 중' : '일부 음원 없음'), !s.clockUsable && '서버 시각 미확인'].filter(Boolean);
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

/** 시간표의 음원 길이 칸: 길이와 실제 끝나는 시각. 다음 방송 시작 전에 안 끝나면 빨간색으로 경고 */
function DurationCell({ ms, slot }: { ms: number; slot?: { at: number; nextAt?: number } }) {
  if (!ms) return <td className="muted">—</td>;
  const end = slot && slot.at + ms;
  const overlap = end !== undefined && slot?.nextAt !== undefined && end > slot.nextAt;
  return (
    <td className={`mono ${overlap ? 'dur-over' : ''}`} title={overlap ? '다음 방송이 시작될 때까지 끝나지 않습니다' : undefined}>
      {formatDuration(ms / 1000)}
      {end !== undefined && <span className={overlap ? '' : 'muted'}> ~{kstTime(end).slice(0, 5)}</span>}
      {overlap && ' ⚠ 다음 방송과 겹침'}
    </td>
  );
}

/** 키 순서와 상관없이 비교하기 위한 JSON (서버에서 읽은 객체는 키 순서가 다를 수 있다) */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([, y]) => y !== undefined).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );
}

/**
 * 이번 시험 종료 늦추기: 영어 듣기평가나 본령이 늦게 시작되어 시험 시간을 보장해야 할 때.
 * 진행 중(또는 다음) 시험의 남은 방송(종료 n분 전·종료령)만 늦추고 다음 교시는 원래 시각대로.
 */
function ExamDelayControl() {
  const [custom, setCustom] = useState('');
  const cur = player.currentExam();
  if (!cur) return null;
  const { end, remaining, delayMs } = cur;
  const add = (ms: number) => player.delayExam(end.cue.id, ms);
  const fmt = (ms: number) => {
    const s = Math.round(ms / 1000);
    return s % 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s / 60}분`;
  };
  return (
    <div className="exam-delay">
      <h3>이번 시험 종료 늦추기</h3>
      <p className="muted small">
        영어 듣기평가나 본령이 늦게 시작되어 시험 시간을 보장해야 할 때 씁니다. 이 시험의 남은 방송만 늦추고, 다음 교시는 원래
        시각대로 진행합니다.
      </p>
      <div className="exam-delay-target">
        <strong>{end.cue.period}</strong> 종료령 <span className="mono big-time">{kstTime(end.at)}</span>
        {delayMs > 0 && (
          <span className="tag delay">
            원래 {kstTime(end.at - delayMs)} → {fmt(delayMs)} 늦춤
          </span>
        )}
        <div className="muted small">늦춰지는 방송: {remaining.map((p) => p.cue.label).join(', ')}</div>
      </div>
      <div className="row">
        <button onClick={() => add(30_000)}>+30초</button>
        <button onClick={() => add(60_000)}>+1분</button>
        <button onClick={() => add(5 * 60_000)}>+5분</button>
        <label className="inline">
          <input type="number" min={0} max={60} step={0.5} value={custom} placeholder="분" onChange={(e) => setCustom(e.target.value)} />
          분
        </label>
        <button
          disabled={!(Number(custom) > 0)}
          onClick={() => {
            add(Math.round(Number(custom) * 60_000));
            setCustom('');
          }}
        >
          늦추기
        </button>
        {delayMs > 0 && (
          <button className="link" onClick={() => add(-delayMs)}>
            되돌리기
          </button>
        )}
      </div>
    </div>
  );
}

const IDLE_REST_KEY = 'csat-cast:idle-rest';

function loadIdleRest(): boolean {
  try {
    return localStorage.getItem(IDLE_REST_KEY) === '1';
  } catch {
    return false;
  }
}

function saveIdleRest(on: boolean) {
  try {
    if (on) localStorage.setItem(IDLE_REST_KEY, '1');
    else localStorage.removeItem(IDLE_REST_KEY);
  } catch {
    /* 저장 못 해도 이번 화면에는 적용 */
  }
}
