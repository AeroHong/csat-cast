import { onDisconnect, onValue, ref, remove, serverTimestamp, set, update } from 'firebase/database';
import { PRESENCE_STALE_MS, presenceAlive, type DevicePresence } from './board';
import { fb } from './firebase';

/**
 * 같은 채널을 연 PC 목록 (RTDB presence/{학교}/{채널}/{기기 id}).
 * 같은 브라우저의 다른 탭은 Web Locks로 막지만, 다른 PC(승인된 교사 여러 명)는 여기서 감지한다.
 * 연결이 끊기면 onDisconnect로 자동으로 지워진다.
 */

const DEVICE_KEY = 'csat-cast:device-id';

/** 이 PC(브라우저 프로필)의 고정 id */
export function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID().slice(0, 12);
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return 'nostorage';
  }
}

export function startPresence(
  school: string,
  channel: string,
  info: { uid: string; email?: string; name?: string },
): { setArmed(armed: boolean): void; stop(): void } {
  if (!fb) return { setArmed() {}, stop() {} };
  const db = fb.rtdb;
  const me = ref(db, `presence/${school}/${channel}/${deviceId()}`);
  let armed = false;
  const host = typeof location === 'undefined' ? '' : location.host;
  const unsub = onValue(ref(db, '.info/connected'), (snap) => {
    if (snap.val() !== true) return;
    void onDisconnect(me)
      .remove()
      .then(() => set(me, { ...info, host, since: serverTimestamp(), seen: serverTimestamp(), armed }))
      .catch(() => undefined);
  });
  // 1분마다 살아 있다고 알린다. 연결이 갑자기 끊겨(절전·강제 종료) 기록이 남아도 3분 뒤에는 닫힌 화면으로 본다
  const beat = setInterval(() => void update(me, { seen: serverTimestamp() }).catch(() => undefined), 60_000);
  return {
    setArmed(a) {
      armed = a;
      void update(me, { armed: a }).catch(() => undefined);
    },
    stop() {
      clearInterval(beat);
      unsub();
      void remove(me).catch(() => undefined);
    },
  };
}

/**
 * 이 채널을 연 PC 목록을 지켜본다. 오래전에 닫힌 화면의 남은 기록(연결이 갑자기 끊겨 안 지워진 것)은 지운다.
 * @param now 서버 기준 현재 시각
 */
export function watchPresence(
  school: string,
  channel: string,
  cb: (devices: Record<string, DevicePresence>) => void,
  now: () => number = Date.now,
) {
  if (!fb) return () => undefined;
  const db = fb.rtdb;
  return onValue(
    ref(db, `presence/${school}/${channel}`),
    (s) => {
      const all = (s.val() ?? {}) as Record<string, DevicePresence>;
      const t = now();
      for (const [id, d] of Object.entries(all)) {
        // 확실히 오래된 것만 지운다 (살아 있다고 알리는 간격의 몇 배)
        if (id !== deviceId() && t - (d.seen ?? d.since) > PRESENCE_STALE_MS * 3) void remove(ref(db, `presence/${school}/${channel}/${id}`)).catch(() => undefined);
      }
      cb(Object.fromEntries(Object.entries(all).filter(([, d]) => presenceAlive(d, t))));
    },
    () => cb({}),
  );
}
