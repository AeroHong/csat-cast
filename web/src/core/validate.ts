import type { Cue, Template } from './types';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/**
 * 서버에서 받은 시간표가 올바른지 검사한다. 문제 목록을 반환 (빈 배열이면 정상).
 * 잘못된 시간표는 사용하지 않고 앱 내장 기본값으로 대체한다.
 */
export function validateTemplate(t: unknown): string[] {
  const errors: string[] = [];
  const tpl = t as Partial<Template> | null;
  if (!tpl || typeof tpl !== 'object') return ['시간표 형식이 아님'];
  if (typeof tpl.name !== 'string' || !tpl.name) errors.push('이름 없음');
  if (!Array.isArray(tpl.cues) || tpl.cues.length === 0) return [...errors, '방송 항목 없음'];
  const ids = new Set<string>();
  tpl.cues.forEach((c: Partial<Cue>, i) => {
    const where = `${i + 1}번째 항목(${c?.id ?? '?'})`;
    if (!c || typeof c.id !== 'string' || !c.id) errors.push(`${where}: id 없음`);
    else if (ids.has(c.id)) errors.push(`${where}: id 중복`);
    else ids.add(c.id);
    if (typeof c?.time !== 'string' || !TIME_RE.test(c.time)) errors.push(`${where}: 시각 형식 오류 (${c?.time})`);
    if (c?.kind !== 'bell' && c?.kind !== 'ment') errors.push(`${where}: 종류 오류`);
    if (typeof c?.assetId !== 'string' || !c.assetId) errors.push(`${where}: 음원 지정 없음`);
    if (c?.lateToleranceSec !== undefined && !(Number(c.lateToleranceSec) >= 0)) errors.push(`${where}: 허용 지연 오류`);
  });
  return errors;
}
