import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { onDisconnect, onValue, ref, serverTimestamp as rtdbNow, update } from 'firebase/database';
import { fb } from './firebase';
import type { RunMode } from './types';

export const APP_VERSION = '0.1.0';
export const HEARTBEAT_MS = 30_000;

/** Realtime DB status/{neisCode}/{channel} 에 기록되는 실시간 상태 */
export interface ChannelStatus {
  online: boolean;
  lastSeen: number;
  schoolName: string;
  channelLabel: string;
  templateId: string;
  mode: RunMode | 'idle';
  clockSynced: boolean;
  clockOffsetMs: number;
  osClockDriftMs: number;
  cacheReady: boolean;
  missingAssets: number;
  audioUnlocked: boolean;
  armed: boolean;
  nextCue: { id: string; label: string; at: number } | null;
  lastCue: { id: string; label: string; result: PlayResult; at: number } | null;
  doneCount: number;
  failedCount: number;
  skippedCount: number;
  appVersion: string;
}

export type PlayResult = 'played' | 'skipped' | 'failed' | 'manual';

export interface PlayLog {
  school: string;
  channel: string;
  cueId: string;
  label: string;
  mode: RunMode;
  scheduledAt: number;
  startedAt: number | null;
  driftMs: number | null;
  result: PlayResult;
  detail?: string;
}

/** 학교 채널 1개의 상태를 서버로 보고. Firebase가 없으면 아무것도 하지 않는다. */
export class Reporter {
  private connectedUnsub: (() => void) | null = null;
  private latest: Partial<ChannelStatus> = {};

  constructor(
    private school: string,
    private channel: string,
  ) {}

  start() {
    if (!fb) return;
    const statusRef = ref(fb.rtdb, `status/${this.school}/${this.channel}`);
    // 재연결될 때마다 onDisconnect를 다시 걸고 최신 상태를 다시 올린다.
    this.connectedUnsub = onValue(ref(fb.rtdb, '.info/connected'), (snap) => {
      if (snap.val() !== true) return;
      void onDisconnect(statusRef)
        .update({ online: false, lastSeen: rtdbNow() })
        .then(() => update(statusRef, { ...this.latest, online: true, lastSeen: rtdbNow() }));
    });
  }

  update(patch: Partial<ChannelStatus>) {
    this.latest = { ...this.latest, ...patch, appVersion: APP_VERSION };
    if (!fb) return;
    void update(ref(fb.rtdb, `status/${this.school}/${this.channel}`), {
      ...this.latest,
      online: true,
      lastSeen: rtdbNow(),
    }).catch(() => {
      /* 오프라인: RTDB SDK가 재연결 시 자동 전송 */
    });
  }

  log(entry: Omit<PlayLog, 'school' | 'channel'>) {
    if (!fb) return;
    void addDoc(collection(fb.db, 'playLogs'), {
      ...entry,
      school: this.school,
      channel: this.channel,
      createdAt: serverTimestamp(),
    }).catch(() => {
      /* 오프라인 퍼시스턴스가 큐잉 */
    });
  }

  stop() {
    this.connectedUnsub?.();
    if (fb) void update(ref(fb.rtdb, `status/${this.school}/${this.channel}`), { online: false, lastSeen: rtdbNow() });
  }
}
