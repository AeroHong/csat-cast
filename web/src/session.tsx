import { onAuthStateChanged, signInWithEmailAndPassword, signOut, type User } from 'firebase/auth';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { fb, schoolEmail } from './core/firebase';

export interface Session {
  loading: boolean;
  user: User | null;
  /** 로그인한 학교의 나이스 코드. 로컬 모드는 'LOCAL'. */
  neisCode: string | null;
  isAdmin: boolean;
  localMode: boolean;
  login(neisCodeOrEmail: string, password: string): Promise<void>;
  enterLocalMode(): void;
  logout(): Promise<void>;
}

const Ctx = createContext<Session | null>(null);
const LOCAL_FLAG = 'csat-cast:local-mode';

export function SessionProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(Boolean(fb));
  const [user, setUser] = useState<User | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [localMode, setLocalMode] = useState(() => !fb || readFlag());

  useEffect(() => {
    if (!fb) return;
    return onAuthStateChanged(fb.auth, async (u) => {
      setUser(u);
      setIsAdmin(u ? (await u.getIdTokenResult()).claims.role === 'admin' : false);
      setLoading(false);
    });
  }, []);

  const neisCode = localMode ? 'LOCAL' : user?.email?.split('@')[0] ?? null;

  const value: Session = {
    loading,
    user,
    neisCode,
    isAdmin,
    localMode,
    async login(id, password) {
      if (!fb) throw new Error('서버 설정이 없어 로그인할 수 없습니다. 로컬 모드를 사용하세요.');
      const email = id.includes('@') ? id : schoolEmail(id);
      await signInWithEmailAndPassword(fb.auth, email, password);
      writeFlag(false);
      setLocalMode(false);
    },
    enterLocalMode() {
      writeFlag(true);
      setLocalMode(true);
    },
    async logout() {
      writeFlag(false);
      setLocalMode(!fb);
      if (fb) await signOut(fb.auth);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('SessionProvider 누락');
  return s;
}

function readFlag() {
  try {
    return localStorage.getItem(LOCAL_FLAG) === '1';
  } catch {
    return false;
  }
}

function writeFlag(on: boolean) {
  try {
    if (on) localStorage.setItem(LOCAL_FLAG, '1');
    else localStorage.removeItem(LOCAL_FLAG);
  } catch {
    /* 저장소 사용 불가 */
  }
}
