/**
 * 평가원 안내방송 음원(6개 유형 폴더)을 앱 기본 음원으로 가져온다.
 *
 *   node scripts/import-audio.ts ["타종 타입" 폴더 경로]   (기본값: 저장소 루트의 "타종 타입")
 *
 * - 폴더 1~6의 같은 이름 파일은 내용이 같아야 하며, 고유 파일만 web/public/audio/builtin/<큐 id>.mp3 로 복사한다.
 * - 파일명(순번-시각-교시-내용)의 시각이 시간표(web/src/data/templates.ts)의 시각과 같은지 검사한다.
 * - 폴더 N의 파일 구성이 시간표 csat-N에 필요한 음원과 정확히 같은지 검사한다.
 * 하나라도 어긋나면 아무것도 바꾸지 않고 종료한다.
 *
 * 음원 파일은 저장소(공개)에 올리지 않는다(.gitignore). 다른 PC에서는 음원 폴더를 복사한 뒤 이 스크립트를 다시 실행한다.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_TEMPLATES } from '../web/src/data/templates.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] ?? join(ROOT, '타종 타입');
const OUT = join(ROOT, 'web/public/audio/builtin');

/** 대본 파일 순번 → 큐 id. 시각은 파일명에서 읽어 시간표와 대조한다. */
const BY_SEQ: Record<string, string> = {
  '01': 'p0-staff', '02': 'p0-notice',
  '03': 'p1-prep', '04': 'p1-ready', '05': 'p1-start', '06': 'p1-10min', '07': 'p1-end',
  '08': 'p2-staff', '09': 'p2-prep', '10': 'p2-ready', '11': 'p2-start', '12': 'p2-10min', '13': 'p2-end',
  '14': 'p3-staff', '15': 'p3-prep', '16': 'p3-ready', '17': 'p3-10min', '18': 'p3-end',
  '19': 'p4-staff', '20': 'p4-prep', '21': 'p4-ready', '22': 'p4-start', '23': 'p4-kh-5min', '24': 'p4-kh-end',
  '25': 'p4-inq-prep', '26': 'p4-inq-ready-a', '27': 'p4-inq-ready-b',
  '28': 'p4-t1-start', '29': 'p4-t1-5min', '30': 'p4-t1-end', '31': 'p4-t2-5min',
  '32': 'p4-end-a', '33': 'p4-end-b', '34': 'p4-end-c',
  '35': 'p5-staff', '36': 'p5-prep', '37': 'p5-ready', '38': 'p5-start', '39': 'p5-10min', '40': 'p5-end',
};
/** 원본 파일명 표기 오류 (07-100-1교시-종료령 = 10:00) */
const TIME_TYPOS: Record<string, string> = { '100': '1000' };

const errors: string[] = [];
const cueTime = new Map<string, string>();
const label = new Map<string, string>();
for (const t of BUILTIN_TEMPLATES)
  for (const c of t.cues) {
    cueTime.set(c.assetId, c.time.slice(0, 5).replace(':', ''));
    label.set(c.assetId, `${c.period} ${c.label}`);
  }

if (!existsSync(SRC)) {
  console.error(`음원 폴더가 없습니다: ${SRC}`);
  process.exit(1);
}

type Found = { id: string; path: string; hash: string; size: number; name: string };
const unique = new Map<string, Found>();
const folders = readdirSync(SRC)
  .filter((d) => /^[1-6]\./.test(d) && statSync(join(SRC, d)).isDirectory())
  .sort();
if (folders.length !== 6) errors.push(`유형 폴더 1~6이 모두 있어야 합니다 (찾은 폴더: ${folders.join(', ') || '없음'})`);

for (const dir of folders) {
  const no = dir[0];
  const ids = new Set<string>();
  for (const name of readdirSync(join(SRC, dir)).filter((f) => f.toLowerCase().endsWith('.mp3'))) {
    const m = /^(\d{2})-(\d{3,4})-/.exec(name);
    const id = m && BY_SEQ[m[1]];
    if (!m || !id) {
      errors.push(`${dir}/${name}: 알 수 없는 파일 (순번-시각-교시-내용 형식이 아님)`);
      continue;
    }
    const fileTime = TIME_TYPOS[m[2]] ?? m[2].padStart(4, '0');
    if (cueTime.get(id) !== fileTime) errors.push(`${name}: 파일 시각 ${fileTime} ≠ 시간표 시각 ${cueTime.get(id) ?? '(시간표에 없음)'} (${id})`);
    const path = join(SRC, dir, name);
    const buf = readFileSync(path);
    const hash = createHash('sha256').update(buf).digest('hex');
    const prev = unique.get(id);
    if (prev && prev.hash !== hash) errors.push(`${name}: 폴더마다 내용이 다름 (${prev.path} 와 비교)`);
    if (!prev) unique.set(id, { id, path, hash, size: buf.length, name });
    ids.add(id);
  }
  const tpl = BUILTIN_TEMPLATES.find((t) => t.id === `csat-${no}`);
  const need = new Set(tpl?.cues.map((c) => c.assetId));
  const missing = [...need].filter((id) => !ids.has(id));
  const extra = [...ids].filter((id) => !need.has(id));
  if (!tpl) errors.push(`${dir}: 대응하는 시간표 csat-${no}가 없음`);
  if (missing.length) errors.push(`${dir}: 시간표 csat-${no}에 필요한 음원 없음 → ${missing.join(', ')}`);
  if (extra.length) errors.push(`${dir}: 시간표 csat-${no}에 없는 음원 → ${extra.join(', ')}`);
}

if (errors.length) {
  console.error('음원 가져오기 중단 (아무것도 바꾸지 않음):\n- ' + errors.join('\n- '));
  process.exit(1);
}

const manifest: Record<string, { file: string; label: string; source: string; sha256: string }> = {};
let total = 0;
for (const f of [...unique.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  const file = `${f.id}.mp3`;
  copyFileSync(f.path, join(OUT, file));
  manifest[f.id] = { file, label: label.get(f.id)!, source: f.name, sha256: f.hash };
  total += f.size;
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`음원 ${unique.size}개 (${(total / 1e6).toFixed(0)}MB) → web/public/audio/builtin/, manifest.json 갱신`);
console.log('폴더 1~6 구성·시각이 시간표 csat-1~6과 모두 일치합니다.');
