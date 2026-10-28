# csat-cast — 수능 방송 자동 스케줄러

타종·안내 멘트 음원을 시간표에 맞춰 자동 송출하고, 시험장별 송출 상태를 교육지원청(admin)에서 실시간으로 확인한다.

## 구성
- `web/` — Vite + React PWA (플레이어 `/player`, 상태판 `/admin/status`)
  - `src/core/scheduler.ts` 큐 계산·놓친 큐 정책 (순수 로직, `npm test`)
  - `src/core/clock.ts` 서버 시각 동기화 (`/api/time`, NTP 방식)
  - `src/core/audio.ts` 음원 사전 로드·정밀 예약 재생 (Web Audio)
  - `src/core/player.ts` 자동 방송 진행기 / `reporter.ts` 실시간 상태·재생 기록 보고
  - `src/data/templates.ts` 기본 시간표 (**초안, 공식 시간표로 검증 필요**)
- `functions/` — `/api/time` (Firebase Functions, 서울 리전)
- `scripts/` — 임시 음원 생성, 초기 데이터 등록(seed)
- `firestore.rules`, `database.rules.json`, `storage.rules`

## 로컬 실행
```
cd web
npm install
npm run dev        # http://localhost:5173 → "로컬 모드로 시작"
npm test
```
Firebase 설정(`web/.env`, `.env.example` 참고)이 없으면 서버 보고 없이 로컬 모드로만 동작한다.

## 음원 교체
`web/public/audio/builtin/` 에 mp3를 넣고 `manifest.json`의 해당 큐 id → `file`을 바꾼다.
현재 파일은 `node scripts/make-placeholder-audio.ts`로 만든 개발용 신호음이다.

## 배포
```
cd scripts && npm install && cd ..
cd functions && npm install && cd ..
cd web && npm run build && cd ..
firebase deploy
set GOOGLE_APPLICATION_CREDENTIALS=service-account.json
node scripts/seed.ts templates
node scripts/seed.ts schools seed/schools.csv
node scripts/seed.ts admin <관리자 이메일>
```
Functions(`minInstances: 1`) 사용으로 Blaze 요금제가 필요하다.
