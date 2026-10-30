/**
 * 평가원 기본 음원을 Firebase Storage(builtin/audio/)에 올린다 (admin 전용, 서비스 계정 키 필요).
 * 음원은 공개 저장소(GitHub)·Hosting에 올리지 않고, 로그인한 시험장만 Storage에서 받는다.
 *
 *   node scripts/import-audio.ts                 # 먼저 web/public/audio/builtin 에 음원·manifest 준비
 *   set GOOGLE_APPLICATION_CREDENTIALS=service-account.json
 *   node scripts/upload-audio.ts [버킷 이름]      # 기본값: web/.env 의 VITE_FIREBASE_STORAGE_BUCKET
 *
 * - manifest.json의 sha256과 파일 내용이 다르면 아무것도 올리지 않고 종료한다.
 * - 이미 같은 내용(sha256)이 올라가 있는 파일은 건너뛰고, manifest에 없는 옛 파일은 지운다.
 * - 브라우저에서 내려받을 수 있도록 버킷 CORS(GET)를 앱 주소로 설정한다.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'web/public/audio/builtin');
const PREFIX = 'builtin/audio/';
const ORIGINS = ['https://csat-cast.web.app', 'https://csat-cast.firebaseapp.com', 'http://localhost:5173', 'http://localhost:5180'];

function bucketFromEnv() {
  const env = join(ROOT, 'web/.env');
  if (!existsSync(env)) return undefined;
  return /^VITE_FIREBASE_STORAGE_BUCKET=(.+)$/m.exec(readFileSync(env, 'utf8'))?.[1].trim();
}

const name = process.argv[2] ?? bucketFromEnv();
if (!name) {
  console.error('버킷 이름을 인자로 주거나 web/.env 에 VITE_FIREBASE_STORAGE_BUCKET 을 설정하세요.');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) as Record<string, { file: string; sha256: string }>;
const files = Object.values(manifest).map((m) => {
  const path = join(DIR, m.file);
  if (!existsSync(path)) return { ...m, path, error: '파일 없음' };
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
  return { ...m, path, error: hash === m.sha256 ? undefined : 'manifest의 sha256과 내용이 다름' };
});
const bad = files.filter((f) => f.error);
if (bad.length) {
  for (const f of bad) console.error(`${f.file}: ${f.error}`);
  console.error('먼저 node scripts/import-audio.ts 를 다시 실행하세요. 아무것도 올리지 않았습니다.');
  process.exit(1);
}

initializeApp();
const bucket = getStorage().bucket(name);

const [existing] = await bucket.getFiles({ prefix: PREFIX });
const remote = new Map(existing.map((f) => [f.name, f.metadata.metadata?.sha256]));
let uploaded = 0;
for (const f of files) {
  const dest = PREFIX + f.file;
  if (remote.get(dest) === f.sha256) continue;
  await bucket.upload(f.path, {
    destination: dest,
    metadata: { contentType: 'audio/mpeg', cacheControl: 'private, max-age=31536000', metadata: { sha256: f.sha256 } },
  });
  uploaded++;
  console.log(`올림 ${dest}`);
}
const keep = new Set(files.map((f) => PREFIX + f.file));
let removed = 0;
for (const f of existing.filter((f) => !keep.has(f.name))) {
  await f.delete();
  removed++;
  console.log(`지움 ${f.name}`);
}

await bucket.setCorsConfiguration([{ origin: ORIGINS, method: ['GET'], responseHeader: ['Content-Type'], maxAgeSeconds: 3600 }]);
console.log(`완료: ${files.length}개 중 ${uploaded}개 올림, ${files.length - uploaded}개는 이미 최신, 옛 파일 ${removed}개 삭제, CORS 설정`);
