import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getDatabase, type Database } from 'firebase/database';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  type Firestore,
} from 'firebase/firestore';
import { getStorage, type FirebaseStorage } from 'firebase/storage';

const config = {
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
}

export const fb: FirebaseServices | null = firebaseEnabled
  ? (() => {
      const app = initializeApp(config);
      return {
        app,
        auth: getAuth(app),
        // 오프라인 퍼시스턴스: 인터넷이 끊겨도 재생 로그를 쌓아 두었다가 재연결 시 업로드
        db: initializeFirestore(app, {
          localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
        }),
        rtdb: getDatabase(app),
        storage: getStorage(app),
      };
    })()
  : null;

/** 나이스 학교코드 → 로그인용 이메일 */
export const schoolEmail = (neisCode: string) => `${neisCode.trim()}@csat-cast.app`;
