/**
 * 전원 상태 (배터리 잔량·충전 중). Chrome·Edge(Windows·안드로이드·크롬북)는 지원, iPad Safari는 지원하지 않는다.
 * 방송 PC가 배터리로 돌다가 꺼지는 사고를 미리 알리기 위함.
 */
import { useEffect, useState } from 'react';

export interface PowerState {
  /** 브라우저가 배터리 정보를 주는가 */
  supported: boolean;
  /** 0~1, 모르면 null */
  level: number | null;
  /** 전원 어댑터 연결됨, 모르면 null */
  charging: boolean | null;
}

interface BatteryManagerLike extends EventTarget {
  level: number;
  charging: boolean;
}

/** 이보다 낮고 충전 중이 아니면 위험 */
export const LOW_BATTERY = 0.2;

export function usePower(): PowerState {
  const [state, setState] = useState<PowerState>({ supported: false, level: null, charging: null });
  useEffect(() => {
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> };
    if (!nav.getBattery) return;
    let battery: BatteryManagerLike | null = null;
    const read = () => battery && setState({ supported: true, level: battery.level, charging: battery.charging });
    void nav
      .getBattery()
      .then((b) => {
        battery = b;
        read();
        b.addEventListener('levelchange', read);
        b.addEventListener('chargingchange', read);
      })
      .catch(() => undefined);
    return () => {
      battery?.removeEventListener('levelchange', read);
      battery?.removeEventListener('chargingchange', read);
    };
  }, []);
  return state;
}

export function powerText(p: PowerState): string {
  if (!p.supported || p.level === null) return '이 기기에서는 배터리 상태를 알 수 없음 — 전원 어댑터 연결을 직접 확인하세요';
  const pct = `${Math.round(p.level * 100)}%`;
  if (p.charging) return `전원 연결됨 (${pct})`;
  return p.level < LOW_BATTERY
    ? `배터리 부족 ${pct} — 지금 바로 전원 어댑터를 연결하세요`
    : `배터리로 동작 중 (${pct}) — 전원 어댑터를 연결하세요`;
}
