// The web dashboard: the browser holds the Cloudflare Access login (a cookie on the Jarvis host),
// so requests are same-origin and carry nothing extra. The app's version is auth.native.ts.
//
// When the Access session cookie expires (24h), every request is answered with a 302 to the
// cloudflareaccess.com login page. fetch() cannot follow that cross-origin redirect, and Safari
// reports the failure as a bare "Load failed" — which used to sit in the banner forever, since a
// home-screen web app has no reload button. So the redirect is requested unfollowed (opaqueredirect)
// and recognised as "signed out": the page reloads itself, which walks through the Access login as a
// navigation (silent while the global session still holds, the email-PIN page otherwise).
export const BASE = "/";
export const fetchInit: RequestInit = { redirect: "manual", credentials: "same-origin" };
export async function authHeaders(): Promise<Record<string, string>> { return {}; }

let reloading = false;
function reloadForLogin(): boolean {
  if (reloading) return true;
  let last = 0;
  try { last = Number(sessionStorage.getItem("access-reload") || 0); } catch {}
  if (Date.now() - last < 60_000) return false; // just reloaded and bounced again: don't loop
  reloading = true;
  try { sessionStorage.setItem("access-reload", String(Date.now())); } catch {}
  setTimeout(() => location.reload(), 50);
  return true;
}
/** Is this response Access turning the request away? Throws the signed-out error if so. */
export async function checkRefused(r: Response): Promise<"ok" | "retry"> {
  if (r.type === "opaqueredirect" || r.status === 0) {
    throw new Error(reloadForLogin()
      ? "signed out of Cloudflare Access — reloading to sign in again"
      : "signed out of Cloudflare Access — reload the page to sign in again");
  }
  return "ok";
}

// the browser is signed in whenever the page loaded at all (Access gates the page itself)
export type AuthState = { phase: "loading" | "signedOut" | "pairing" | "ready"; note: string | null };
const READY: AuthState = { phase: "ready", note: null };
export const useAuthState = () => READY;
export const getAuthState = () => READY;
export async function loadCreds() {}
export async function signIn() {}
