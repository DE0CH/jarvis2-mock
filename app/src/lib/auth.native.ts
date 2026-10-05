// Jarvis 2 mock: no pairing. The app talks to the mock backend (server/ in this repo) at the base URL
// baked in at bundle time (EXPO_PUBLIC_JARVIS_BASE); it holds no credential of the real Jarvis.
import { useSyncExternalStore } from "react";

const base = process.env.EXPO_PUBLIC_JARVIS_BASE || "http://127.0.0.1:18080/";
export const BASE = base.endsWith("/") ? base : base + "/";
export const fetchInit: RequestInit = { credentials: "omit" };

export type AuthState = { phase: "loading" | "signedOut" | "pairing" | "ready"; note: string | null };
const state: AuthState = { phase: "ready", note: null };
export const useAuthState = () => useSyncExternalStore(() => () => {}, () => state);
export const getAuthState = () => state;
export async function loadCreds() {}
export async function authHeaders(): Promise<Record<string, string>> { return {}; }
export async function checkRefused(_r: Response): Promise<"ok" | "retry"> { return "ok"; }
export async function signIn(): Promise<void> {}
