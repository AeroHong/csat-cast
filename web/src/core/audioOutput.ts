/**
 * 방송 소리 출력 장치 고르기 (Windows의 Chrome·Edge).
 * 윈도우 기본 출력은 내장 스피커로 두고 방송 소리만 앰프 쪽 장치로 보내면, 알림음·다른 프로그램 소리가 교실 방송에 섞이지 않는다.
 * - 윈도우 기본 장치 자체는 바꿀 수 없다 (웹 권한 밖)
 * - 장치 이름을 보려면 처음 한 번 마이크 권한이 필요하다 (Chrome이 이름을 숨김, 마이크는 쓰지 않음)
 * 고른 장치는 이 PC에 저장한다.
 */
import { useEffect, useState } from 'react';
import { audioEngine } from './audio';

export interface OutputChoice {
  deviceId: string;
  label: string;
}

export interface OutputDevice {
  deviceId: string;
  label: string;
}

const KEY = 'csat-cast:audio-output';

export function outputSupported(): boolean {
  return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype && !!navigator.mediaDevices?.enumerateDevices;
}

export function loadChoice(): OutputChoice | null {
  try {
    const v = localStorage.getItem(KEY);
    return v ? (JSON.parse(v) as OutputChoice) : null;
  } catch {
    return null;
  }
}

function saveChoice(c: OutputChoice | null) {
  try {
    if (c) localStorage.setItem(KEY, JSON.stringify(c));
    else localStorage.removeItem(KEY);
  } catch {
    /* 저장 못 해도 이번 화면에는 적용 */
  }
}

/** 출력 장치 목록. 권한이 없으면 이름·id가 비어 있어 목록을 만들 수 없다 → null */
async function listOutputs(): Promise<OutputDevice[] | null> {
  const all = await navigator.mediaDevices.enumerateDevices();
  const outs = all.filter((d) => d.kind === 'audiooutput');
  if (!outs.some((d) => d.deviceId && d.label)) return null;
  // 'default'·'communications'는 윈도우가 정한 가상 항목이라 빼고, 실제 장치만 보여 준다
  return outs.filter((d) => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => ({ deviceId: d.deviceId, label: d.label }));
}

export type OutputLevel = 'ok' | 'warn' | 'bad';

/** 방송 준비 점검 표시 (순수 함수) */
export function outputStatus(s: {
  supported: boolean;
  choice: OutputChoice | null;
  devices: OutputDevice[] | null;
  error?: string | null;
}): { level: OutputLevel; text: string } {
  if (!s.supported) return { level: 'warn', text: '이 브라우저는 출력 장치 선택을 지원하지 않음 — 윈도우 소리 설정에서 기본 출력을 앰프 쪽으로 맞추세요' };
  if (!s.choice) return { level: 'warn', text: '윈도우 기본 장치로 나감 — 알림음이 방송에 섞이지 않게 아래에서 앰프 쪽 장치를 고르세요' };
  if (s.error) return { level: 'bad', text: `"${s.choice.label}"로 보내지 못함 (${s.error}) — 윈도우 기본 장치로 나갑니다` };
  if (s.devices && !s.devices.some((d) => d.deviceId === s.choice!.deviceId))
    return { level: 'bad', text: `고른 장치 "${s.choice.label}"가 연결되어 있지 않음 — 윈도우 기본 장치로 나갑니다 (케이블·USB 확인)` };
  return { level: 'ok', text: `방송 소리는 "${s.choice.label}"로만 나갑니다 (다른 소리는 윈도우 기본 장치로)` };
}

/** 출력 장치 상태와 고르기. 장치를 뽑았다 꽂으면 다시 맞춘다 */
export function useAudioOutput() {
  const supported = outputSupported();
  const [choice, setChoice] = useState<OutputChoice | null>(loadChoice);
  const [devices, setDevices] = useState<OutputDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 장치 목록 갱신 + 고른 장치에 맞추기 (없으면 기본 장치)
  async function sync(c: OutputChoice | null = choice) {
    if (!supported) return;
    const list = await listOutputs().catch(() => null);
    setDevices(list);
    const present = !c ? false : list ? list.some((d) => d.deviceId === c.deviceId) : true; // 목록을 못 보면 일단 시도
    try {
      await audioEngine.setOutput(c && present ? c.deviceId : '');
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await audioEngine.setOutput('').catch(() => undefined);
    }
  }

  useEffect(() => {
    if (!supported) return;
    void sync();
    const onChange = () => void sync();
    navigator.mediaDevices.addEventListener('devicechange', onChange);
    return () => navigator.mediaDevices.removeEventListener('devicechange', onChange);
  }, [choice?.deviceId]);

  /** 장치 이름을 보기 위한 권한 요청 (마이크는 바로 끈다) */
  async function requestList() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch {
      setError('장치 목록을 보려면 권한 허용이 필요합니다 (마이크는 쓰지 않습니다)');
      return;
    }
    await sync();
  }

  function choose(deviceId: string) {
    const d = devices?.find((x) => x.deviceId === deviceId);
    const c = d ? { deviceId: d.deviceId, label: d.label } : null;
    saveChoice(c);
    setChoice(c);
  }

  return { supported, choice, devices, error, status: outputStatus({ supported, choice, devices, error }), requestList, choose };
}
