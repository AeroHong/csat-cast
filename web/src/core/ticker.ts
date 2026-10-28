/**
 * Web Worker 기반 타이머. 메인 스레드의 setInterval은 백그라운드 탭에서 크게 지연될 수 있지만
 * 전용 워커의 타이머는 그 영향을 덜 받는다.
 */
const workerSource = `
  let id = null;
  onmessage = (e) => {
    if (id) clearInterval(id);
    if (e.data > 0) id = setInterval(() => postMessage(0), e.data);
  };
`;

export function startTicker(intervalMs: number, onTick: () => void): () => void {
  let worker: Worker | null = null;
  try {
    const url = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    worker = new Worker(url);
    URL.revokeObjectURL(url);
    worker.onmessage = onTick;
    worker.postMessage(intervalMs);
    return () => worker?.terminate();
  } catch {
    const id = setInterval(onTick, intervalMs);
    return () => clearInterval(id);
  }
}
