import { useEffect, useRef, useState } from 'react';
import { audioEngine, type NowPlaying as Playing } from '../core/audio';

/** 초 → "m:ss" */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 지금 소리가 나고 있는 음원 목록 (0.1초마다 갱신). 자동 송출·수동 재생 모두 포함 */
export function useNowPlaying(): Playing[] {
  const [list, setList] = useState<Playing[]>([]);
  useEffect(() => {
    const id = setInterval(() => {
      const next = audioEngine.nowPlaying();
      // 아무것도 안 나올 때는 다시 그리지 않는다
      setList((prev) => (prev.length === 0 && next.length === 0 ? prev : next));
    }, 100);
    return () => clearInterval(id);
  }, []);
  return list;
}

const cssVar =(name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** 캔버스를 화면 픽셀 밀도에 맞추고 2D 컨텍스트를 돌려준다 */
function fitCanvas(c: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(c.clientWidth * dpr);
  const h = Math.round(c.clientHeight * dpr);
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  return c.getContext('2d');
}

/** 음원 전체 파형 + 지금 재생 위치 */
function Waveform({ assetId, progress }: { assetId: string; progress: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const g = c && fitCanvas(c);
    const peaks = audioEngine.peaks(assetId);
    if (!c || !g) return;
    const { width: w, height: h } = c;
    g.clearRect(0, 0, w, h);
    const played = cssVar('--primary');
    const rest = cssVar('--none');
    if (peaks) {
      const barW = w / peaks.length;
      for (let i = 0; i < peaks.length; i++) {
        const v = Math.max(0.02, peaks[i]) * (h / 2);
        g.fillStyle = i / peaks.length <= progress ? played : rest;
        g.fillRect(i * barW, h / 2 - v, Math.max(1, barW - 0.5), v * 2);
      }
    }
    const x = Math.round(progress * w);
    g.fillStyle = cssVar('--bad');
    g.fillRect(x - 1, 0, 2, h);
  }, [assetId, progress]);
  return <canvas ref={ref} className="waveform" aria-label="음원 파형과 재생 위치" />;
}

/** 실시간 주파수 스펙트럼 (가로: 로그 주파수 50Hz~16kHz, 세로: 세기) */
function Spectrum({ active }: { active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const data = new Uint8Array(audioEngine.frequencyBins || 1024);
    const BANDS = 72;
    const lo = Math.log10(50);
    const hi = Math.log10(16000);
    const draw = () => {
      const c = ref.current;
      const g = c && fitCanvas(c);
      if (c && g && audioEngine.frequencyData(data)) {
        const { width: w, height: h } = c;
        const binHz = audioEngine.sampleRate / 2 / data.length;
        g.clearRect(0, 0, w, h);
        const color = cssVar('--primary');
        const labelH = 14 * (window.devicePixelRatio || 1);
        const plotH = h - labelH;
        for (let b = 0; b < BANDS; b++) {
          const f0 = 10 ** (lo + ((hi - lo) * b) / BANDS);
          const f1 = 10 ** (lo + ((hi - lo) * (b + 1)) / BANDS);
          let max = 0;
          for (let i = Math.floor(f0 / binHz); i <= Math.min(data.length - 1, Math.ceil(f1 / binHz)); i++) max = Math.max(max, data[i]);
          const v = (max / 255) * plotH;
          g.fillStyle = color;
          g.globalAlpha = 0.35 + 0.65 * (max / 255);
          g.fillRect((b * w) / BANDS + 1, plotH - v, w / BANDS - 2, v);
        }
        g.globalAlpha = 1;
        g.fillStyle = cssVar('--muted');
        g.font = `${11 * (window.devicePixelRatio || 1)}px system-ui`;
        for (const [f, t] of [[100, '100Hz'], [1000, '1kHz'], [10000, '10kHz']] as const) {
          g.fillText(t, ((Math.log10(f) - lo) / (hi - lo)) * w + 2, h - 2);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return <canvas ref={ref} className="spectrum" aria-label="실시간 주파수 스펙트럼" />;
}

/**
 * 시간표에서 재생 중인 줄 바로 아래에 펼치는 상세: 진행 막대(현재 위치/길이)·파형, 전체 출력의 실시간 스펙트럼.
 * 방송에는 관여하지 않고 오디오 엔진 상태를 읽기만 한다.
 */
export default function NowPlayingDetail({ p }: { p: Playing }) {
  const progress = p.durationSec ? p.positionSec / p.durationSec : 0;
  return (
    <div className="np-detail">
      <div className="np-wave">
        <div className="np-head mono">
          <span>
            {formatDuration(p.positionSec)} / {formatDuration(p.durationSec)}
          </span>
          <span className="muted">남은 {formatDuration(p.durationSec - p.positionSec)}</span>
        </div>
        <div className="np-bar" role="progressbar" aria-valuemin={0} aria-valuemax={Math.round(p.durationSec)} aria-valuenow={Math.round(p.positionSec)}>
          <div style={{ width: `${progress * 100}%` }} />
        </div>
        <Waveform assetId={p.assetId} progress={progress} />
      </div>
      <div className="np-spectrum">
        <div className="muted small">출력 스펙트럼</div>
        <Spectrum active />
      </div>
    </div>
  );
}
