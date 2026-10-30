import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import type { Connect, Plugin } from 'vite';

/** 로컬 실행(dev/preview)에서도 Firebase Functions와 같은 /api/time 응답을 제공 */
const timeApi: Connect.NextHandleFunction = (req, res, next) => {
  if (!req.url?.startsWith('/api/time')) return next();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ now: Date.now() }));
};
const localTimeApi: Plugin = {
  name: 'local-time-api',
  configureServer: (s) => void s.middlewares.use(timeApi),
  configurePreviewServer: (s) => void s.middlewares.use(timeApi),
};

export default defineConfig({
  plugins: [
    react(),
    localTimeApi,
    VitePWA({
      // prompt: 새 버전을 바로 적용하지 않고 updates.ts가 방송 상태를 보고 적용 시점을 정한다
      registerType: 'prompt',
      manifest: {
        name: '수능 방송 스케줄러',
        short_name: 'CSAT Cast',
        lang: 'ko',
        display: 'standalone',
        background_color: '#0f172a',
        theme_color: '#0f172a',
        start_url: '/player',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
      },
      workbox: {
        // 앱 화면만 미리 캐시한다. 음원(약 115MB)은 모든 방문자에게 내려보내지 않고,
        // 학교 플레이어가 자기 시간표에 필요한 것만 audio.ts의 자체 캐시(csat-audio-v1)에 저장해 오프라인에 대비한다.
        globPatterns: ['**/*.{js,css,html,svg,json}'],
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // 학교별 업로드 음원 (Firebase Storage)
            urlPattern: /^https:\/\/firebasestorage\.googleapis\.com\//,
            handler: 'CacheFirst',
            options: { cacheName: 'school-audio', expiration: { maxEntries: 200 } },
          },
        ],
      },
    }),
  ],
  test: {
    environment: 'node',
  },
});
