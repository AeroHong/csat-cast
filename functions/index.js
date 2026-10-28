import { onRequest } from 'firebase-functions/v2/https';

/**
 * 서버 기준 시각. 모든 시험장의 방송 시각은 이 값에 맞춰진다.
 * 평소에는 0(비용 없음). 수능 주간(11/16~11/19)에는 MIN_INSTANCES=1 로 다시 배포해 콜드스타트를 없앤다.
 * 콜드스타트가 있어도 클라이언트는 RTT 최소 샘플을 쓰므로 정확도에는 영향이 없다.
 */
const MIN_INSTANCES = Number(process.env.MIN_INSTANCES ?? 0);
export const time = onRequest(
  { region: 'asia-northeast3', minInstances: MIN_INSTANCES, cors: true, memory: '128MiB' },
  (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ now: Date.now() });
  },
);
