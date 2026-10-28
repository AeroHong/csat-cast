import { registerSW } from 'virtual:pwa-register';
import { player } from './player';

/**
 * 앱 업데이트 관리.
 * 새 버전이 배포돼도 자동 방송 중에는 절대 새로고침하지 않는다 (새로고침하면 오디오가 꺼질 수 있음).
 * 방송 대기 상태가 아닐 때만 적용하고, 방송 중이면 끝난 뒤 적용한다.
 */
let applyUpdate: ((reload?: boolean) => Promise<void>) | null = null;
let pending = false;
const listeners = new Set<(pending: boolean) => void>();

export function initUpdates() {
  applyUpdate = registerSW({
    immediate: true,
    onNeedRefresh() {
      pending = true;
      listeners.forEach((fn) => fn(true));
      tryApply();
    },
    onRegisteredSW(_url, reg) {
      // 장시간 켜 두는 PC를 위해 1시간마다 새 버전 확인 (적용은 tryApply 규칙을 따름)
      if (reg) setInterval(() => void reg.update(), 60 * 60_000);
    },
  });
  // 방송이 끝나면(중지되면) 미뤄 둔 업데이트 적용
  player.subscribe((s) => !s.armed && tryApply());
}

function tryApply() {
  if (pending && !player.armed && applyUpdate) void applyUpdate(true);
}

export function onUpdatePending(fn: (pending: boolean) => void) {
  listeners.add(fn);
  fn(pending);
  return () => listeners.delete(fn);
}
