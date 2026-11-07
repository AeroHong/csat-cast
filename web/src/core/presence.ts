import { onDisconnect, onValue, ref, remove, serverTimestamp, set, update } from 'firebase/database';
import type { DevicePresence } from './board';
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
  const unsub = onValue(ref(db, '.info/connected'), (snap) => {
    if (snap.val() !== true) return;
    void onDisconnect(me)
      .remove()
      .then(() => set(me, { ...info, since: serverTimestamp(), armed }))
      .catch(() => undefined);
  });
  return {
    setArmed(a) {
      armed = a;
      void update(me, { armed: a }).catch(() => undefined);
    },
    stop() {
      unsub();
      void remove(me).catch(() => undefined);
    },
  };
}

/** 이 채널을 연 PC 목록을 지켜본다 */
export function watchPresence(school: string, channel: string, cb: (devices: Record<string, DevicePresence>) => void) {
  if (!fb) return () => undefined;
  return onValue(
    ref(fb.rtdb, `presence/${school}/${channel}`),
    (s) => cb((s.val() ?? {}) as Record<string, DevicePresence>),
    () => cb({}),
  );
}
