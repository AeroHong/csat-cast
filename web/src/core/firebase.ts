import { initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, type Auth } from 'firebase/auth';
import { connectDatabaseEmulator, getDatabase, type Database } from 'firebase/database';
import {
  connectFirestoreEmulator,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, type Functions } from 'firebase/functions';
import { getStorage, type FirebaseStorage } from 'firebase/storage';

/**
 * 개발 서버 전용: VITE_USE_EMULATOR=1 이면 Firebase 에뮬레이터(demo-csat-cast)에 붙는다.
 * 실제 서버에 아무것도 쓰지 않고 로그인·승인·현황판을 시험할 수 있다 (README '에뮬레이터로 시험하기').
 */
export const usingEmulator = import.meta.env.DEV && import.meta.env.VITE_USE_EMULATOR === '1';
const EMU_PROJECT = 'demo-csat-cast';

const config = usingEmulator
  ? {
      apiKey: 'demo-key',
      authDomain: `${EMU_PROJECT}.firebaseapp.com`,
      projectId: EMU_PROJECT,
      storageBucket: `${EMU_PROJECT}.appspot.com`,
      appId: 'demo-app',
      databaseURL: `http://127.0.0.1:9000/?ns=${EMU_PROJECT}-default-rtdb`,
    }
  : {
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
      appId: import.meta.env.VITE_FIREBASE_APP_ID,
      databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
    };

/** Firebase 설정이 없으면 "로컬 모드"로 동작 (서버 보고 없이 재생만). */
export const firebaseEnabled = Boolean(config.apiKey && config.projectId);

export interface FirebaseServices {
  app: FirebaseApp;
  auth: Auth;
  db: Firestore;
  rtdb: Database;
  storage: FirebaseStorage;
  /** 관리자 기능(사용 승인·회수·유형 변경) 호출용 — 서울 리전 */
  functions: Functions;
}

export const fb: FirebaseServices | null = firebaseEnabled
  ? (() => {
      const app = initializeApp(config);
      const services = {
        app,
        auth: getAuth(app),
        // 오프라인 퍼시스턴스: 인터넷이 끊겨도 재생 로그를 쌓아 두었다가 재연결 시 업로드
        db: initializeFirestore(app, {
          localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
        }),
        rtdb: getDatabase(app),
        storage: getStorage(app),
        functions: getFunctions(app, 'asia-northeast3'),
      };
      if (usingEmulator) {
        connectAuthEmulator(services.auth, 'http://127.0.0.1:9099', { disableWarnings: true });
        connectFirestoreEmulator(services.db, '127.0.0.1', 8080);
        connectDatabaseEmulator(services.rtdb, '127.0.0.1', 9000);
        connectFunctionsEmulator(services.functions, '127.0.0.1', 5001);
      }
      return services;
    })()
  : null;

/** 학교 id → 예전 학교 공용 계정 이메일 (테스트 학교 9999999 등) */
export const schoolEmail = (neisCode: string) => `${neisCode.trim()}@csat-cast.app`;
