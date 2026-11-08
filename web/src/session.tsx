import {
  GoogleAuthProvider,
  browserLocalPersistence,
  getRedirectResult,
  onIdTokenChanged,
  setPersistence,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type User,
} from 'firebase/auth';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { fb, schoolEmail } from './core/firebase';
import { player } from './core/player';

export interface Session {
  loading: boolean;
  user: User | null;
  /**
   * 로그인한 학교의 id (나이스 학교코드 또는 시험장 번호 d13-20 등). 로컬 모드는 'LOCAL'.
   * 승인된 담당 교사는 custom claim schoolId, 예전 학교 공용 계정은 이메일 앞부분에서 얻는다.
   */
  neisCode: string | null;
  isAdmin: boolean;
  /** 구글 계정으로 로그인했지만 아직 관리자 승인 전 (학교 권한 없음) */
  pendingApproval: boolean;
  localMode: boolean;
  /**
   * 자동 방송 중에 로그인이 끊겼다 (권한 회수·토큰 만료 등).
   * 방송을 멈추지 않도록 학교 id를 그대로 유지하고, 서버 보고만 안 된다.
   */
  authLost: boolean;
  /** 화면에 보여 줄 운영자 (이름 또는 이메일) */
  operator: string;
  loginWithGoogle(): Promise<void>;
  login(idOrEmail: string, password: string): Promise<void>;
  /** 승인 직후 새 권한(custom claim)을 받기 위해 토큰을 다시 받는다 */
  refreshClaims(): Promise<void>;
  enterLocalMode(): void;
  logout(): Promise<void>;
}

const Ctx = createContext<Session | null>(null);
const LOCAL_FLAG = 'csat-cast:local-mode';
const LEGACY_DOMAIN = '@csat-cast.app';

interface Claims {
  isAdmin: boolean;
  schoolId: string | null;
}

async function readClaims(u: User | null, force = false): Promise<Claims> {
  if (!u) return { isAdmin: false, schoolId: null };
  const t = await u.getIdTokenResult(force);
  const isAdmin = t.claims.role === 'admin';
  const claimSchool = typeof t.claims.schoolId === 'string' && t.claims.schoolId ? t.claims.schoolId : null;
  const legacy = u.email?.endsWith(LEGACY_DOMAIN) ? u.email.slice(0, -LEGACY_DOMAIN.length) : null;
  // 관리자 ID 계정({id}@csat-cast.app)은 예전 학교 공용 계정과 형식이 같으므로 학교로 읽지 않는다
  return { isAdmin, schoolId: claimSchool ?? (isAdmin ? null : legacy) };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(Boolean(fb));
  const [user, setUser] = useState<User | null>(null);
  const [claims, setClaims] = useState<Claims>({ isAdmin: false, schoolId: null });
  const [localMode, setLocalMode] = useState(() => !fb || readFlag());

  useEffect(() => {
    if (!fb) return;
    // 한 번 로그인하면 이 PC(브라우저 프로필)에 계속 유지 — 수능 당일 아침 다시 로그인할 필요 없음
    void setPersistence(fb.auth, browserLocalPersistence).catch(() => undefined);
    // 팝업이 막혀 리디렉션으로 로그인한 경우의 결과 처리 (오류는 무시하고 로그인 화면 유지)
    void getRedirectResult(fb.auth).catch(() => undefined);
    // 토큰이 바뀔 때마다(승인 후 갱신 포함) 권한을 다시 읽는다
    return onIdTokenChanged(fb.auth, async (u) => {
      const c = await readClaims(u).catch(() => ({ isAdmin: false, schoolId: null }));
      setUser(u);
      setClaims(c);
      setLoading(false);
    });
  }, []);

  // 자동 방송 중 로그인이 끊겨도 방송 화면이 닫히지 않도록 마지막 학교 id를 붙잡아 둔다
  const lastSchool = useRef<string | null>(null);
  if (claims.schoolId) lastSchool.current = claims.schoolId;
  const authLost = !localMode && !claims.schoolId && !claims.isAdmin && !!lastSchool.current && player.armed;
  const neisCode = localMode ? 'LOCAL' : claims.schoolId ?? (authLost ? lastSchool.current : null);
  const value: Session = {
    loading,
    user,
    neisCode,
    isAdmin: claims.isAdmin,
    pendingApproval: !localMode && !!user && !claims.isAdmin && !claims.schoolId && !authLost,
    localMode,
    authLost,
    operator: user?.displayName || user?.email || '',
    async loginWithGoogle() {
      if (!fb) throw new Error('서버 설정이 없어 로그인할 수 없습니다. 로컬 모드를 사용하세요.');
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      try {
        await signInWithPopup(fb.auth, provider);
      } catch (e) {
        const code = (e as { code?: string }).code;
        // 팝업이 막힌 환경(학교 PC 보안 설정 등)은 페이지 이동 방식으로
        if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
          await signInWithRedirect(fb.auth, provider);
          return;
        }
        throw e;
      }
      writeFlag(false);
      setLocalMode(false);
    },
    async login(id, password) {
      if (!fb) throw new Error('서버 설정이 없어 로그인할 수 없습니다. 로컬 모드를 사용하세요.');
      const email = id.includes('@') ? id : schoolEmail(id);
      await signInWithEmailAndPassword(fb.auth, email, password);
      writeFlag(false);
      setLocalMode(false);
    },
    async refreshClaims() {
      if (!fb?.auth.currentUser) return;
      setClaims(await readClaims(fb.auth.currentUser, true));
    },
    enterLocalMode() {
      writeFlag(true);
      setLocalMode(true);
    },
    async logout() {
      lastSchool.current = null;
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
