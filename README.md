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

## 다른 PC에서 이어서 작업하기
git에 올라가지 않는 파일 2개를 직접 복사해야 한다.
- `service-account.json` (프로젝트 루트) — 초기 데이터 등록용 비밀 키
- `web/.env` — Firebase 웹 설정 (`web/.env.example` 참고, 값은 Firebase 콘솔 → 프로젝트 설정)

```
cd web && npm install && npm test && npm run dev
npx firebase-tools login      # 배포할 때만
```
개발 서버에서 `http://localhost:5173/player?devArmed=1` → 오늘을 방송일로 가정하고 60배속으로 자동 방송을 시험할 수 있다.

## 작업 현황 (2026-10-28 기준)
완료
- 자동 방송 엔진(서버 시각 동기화, 정밀 예약 재생), 학교 플레이어, 관리자 실시간 상태판
- Firebase 배포: Hosting(https://csat-cast.web.app), Functions `/api/time`(서울), 보안 규칙, 시간표 초안 업로드, 관리자 권한, 테스트 학교 계정(9999999)
- 안정성 강화: 방송 중 앱 업데이트 금지, 방송일 자동 시작, 새로고침 후 이어하기(중복 송출 방지), 오디오 꺼짐·PC 절전 감시,
  같은 채널 이중 탭 차단, 스피커 확인, 오프라인 재시작 시 저장된 시각 사용, 잘못된 시간표 차단, 상태판 경고음, 전용 실행 아이콘(`web/public/launcher`)

남은 일
- [x] 새로고침 이어하기 브라우저 실측 확인 (2026-10-30, 전용 실행 아이콘과 같은 옵션의 크롬에서 큐 사이·재생 중·타종 직전 새로고침 모두 정상)
  - 함께 고침: 타종 직전(예약 상태) 새로고침 시 안 울렸는데 송출 완료 처리되던 문제, 소리 꺼짐 중 큐가 송출 완료로 기록되고 켜질 때 늦게 울리던 문제, 음원 캐시 저장 오류로 음원 전체가 준비 실패되던 문제
- [ ] 위 변경사항 Hosting 재배포 (`cd web && npm run build && cd .. && npx firebase-tools deploy --only hosting`)
- [ ] 실제 mp3 교체, 공식 시간표(일반·연장 시험실) 반영 후 verified=true
- [ ] 시험장 목록 CSV로 학교 계정 일괄 생성
- [ ] 학교별 시간표 조정 화면(큐 끄기/켜기, 자체 mp3 업로드), 관리자 관리 화면, 학교×교시 송출 표
- [ ] 수능 주간 Functions `MIN_INSTANCES=1` 재배포
