// Thin JSON client for the Jarvis API, shared by the web page and the app. Paths are written
// "api/state"; auth.ts / auth.native.ts say where they go and how the request is authorised.
import { BASE, fetchInit, authHeaders, checkRefused } from "./auth";

export const url = (path: string) => BASE + path.replace(/^\//, "");

// What a failed request means, in words. Jarvis itself answers errors as JSON {error}, but
// the layers in front of it answer plain text or HTML (the cf-tunnel worker: "tunnel agent is not
// connected" while Jarvis pod restarts; Express: "Cannot POST /x"), and a dropped connection
// is only the platform's bare "Load failed" / "Network request failed". Every error names the request and
// carries whatever reason the server gave, plus a plain-language gloss of the status.
const STATUS_HINT: Record<number, string> = {
  400: "bad request", 401: "not authorised", 403: "forbidden", 404: "not found", 409: "conflict",
  413: "request too large", 429: "rate-limited — try again shortly", 500: "jarvis error",
  502: "bad gateway — Jarvis or tunnel agent dropped the request",
  503: "unavailable — Jarvis is restarting or its tunnel agent is disconnected",
  504: "timed out — no response from Jarvis in time",
};
export function reasonOf(text: string): string {
  let j: any = null; try { j = JSON.parse(text); } catch {}
  if (j && typeof j === "object") return String(j.error || j.message || "");
  return text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}
export function httpError(method: string, path: string, status: number, text: string): Error {
  const reason = reasonOf(text), hint = STATUS_HINT[status] || (status >= 500 ? "server error" : "request failed");
  const e: any = new Error(`${reason || hint} (HTTP ${status}${reason ? " " + hint : ""} · ${method} ${path})`);
  e.status = status;
  // a refusal because the session is mid-way through another action: 409 {busy: {kind, since}}
  try { const j = JSON.parse(text); if (j && j.busy) e.busy = j.busy; } catch {}
  return e;
}
export function networkError(method: string, path: string, e: any): Error {
  const offline = typeof navigator !== "undefined" && (navigator as any).onLine === false;
  const why = offline ? "this device is offline" : "the connection to Jarvis dropped or never opened (tunnel down, network change, or the request ran too long)";
  return new Error(`network error: ${why} — ${method} ${path}${e?.message ? " · " + e.message : ""}`);
}
export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response;
  for (;;) {
    try {
      r = await fetch(url(path), {
        ...fetchInit, method,
        headers: { ...(await authHeaders()), ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) { throw networkError(method, path, e); }
    if ((await checkRefused(r)) === "ok") break;
  }
  const text = await r.text().catch(() => "");
  if (!r.ok) throw httpError(method, path, r.status, text);
  try { return JSON.parse(text) as T; }
  catch { throw new Error(`Jarvis answered ${method} ${path} with something that isn't JSON: ${reasonOf(text) || "(empty body)"}`); }
}

export type Session = {
  // id = the stable session id (its first machine's id); machineId = the Fly machine it is on now,
  // null while paused (a paused session keeps no machine — `released`)
  id: string; machineId?: string | null; released?: boolean; pausedAt?: string;
  name: string; state: string; status?: string; bgTasks?: number; created?: string; region?: string;
  environment?: string; repos?: string; permissionMode?: string; model?: string; harness?: string; label?: string; liveName?: string;
  nameSource?: string; aiTitle?: string; serverTitle?: string; guest?: string; autoPause?: string; apiProxy?: string; pauseInMs?: number;
  oneShot?: boolean; oneShotDone?: boolean; createRequestId?: string;
  // paused, from its pause snapshot's transcript: what the conversation ended on (aiTitle is filled from it too)
  last?: { role: "user" | "assistant"; text: string; at: string | null } | null; hasTranscript?: boolean;
  resumePrompt?: string; // a Start/Restore prompt Jarvis has not typed in yet
  wakeup?: { at: number; atIso: string; prompt: string } | null; // a scheduled wakeup: Jarvis starts it at `at` and types `prompt` in
  wakeups?: { name: string; at: number; atIso: string; prompt: string }[]; // every scheduled wakeup (several named ones per session), soonest first
  crons?: { name: string; prompt: string; everySeconds: number; nextAt: number }[]; // recurring wakeups
  watches?: { name: string; prompt: string; interval: number; expiresAtIso: string; runs: number; lastExit?: number | null; lastRunIso?: string | null; lastError?: string }[]; // conditional wakeups: a check script Jarvis runs every `interval` s
  destroy?: { phase: string; error?: string | null; archiveFailed?: boolean }; // a destroy job Jarvis is running for it
  wake?: { kind: string; phase: string; error?: string | null; needLogin?: boolean }; // a start/restart/mode-switch job Jarvis is running for it
  busy?: { kind: string; since: number }; // Jarvis holds this session's lock for a lifecycle action — other actions are refused until it ends
};
// a destroyed session in Jarvis's index (api/records) — restorable from its archived transcript
export type PrevSession = {
  id: string; title: string; machineName?: string; environment?: string; repos?: string; permissionMode?: string; model?: string; size?: string;
  oneShot?: boolean; apiProxy?: string; created?: string; destroyedAt: string; archiveDir: string; transcripts: number;
  artifacts: number | null; // files under ~/artifacts; null = kept as one tarball (destroyed while paused)
  last?: { role: "user" | "assistant"; text: string; at: string | null } | null; // what the conversation ended on
  indexedByHand?: boolean; // an older / hand-uploaded archive indexed on purpose (POST api/records)
  restored?: { sessionId: string; at: string }[];
  restore?: { phase: string; error?: string | null }; // a restore job Jarvis is running (or just ran) for it
};
// anything on the Fly account that is NOT a session: a machine in another app, a volume anywhere, an empty app
export type FlyOther = { kind: "machine" | "volume" | "app"; app: string; id: string; name: string; state: string; region: string; created: string | null; detail: string };
export type FlyAccount = { apps: number; machines: number; volumes: number; other: FlyOther[]; error: string | null; checkedAt: string | null };
export type TailMessage = { role: "user" | "assistant"; text: string; at: string | null };
// a shared device (the WeChat cloud phone, the iPhone): at most one holder session + a FIFO queue
// (holder.human: Deyao took it over from the dashboard; it never expires until he hands it back)
export type LeaseEvent = { at: number; kind: "granted" | "returned" | "force-returned" | "expired" | "promoted" | "taken-over" | "handed-back"; sid: string | null; note?: string; purpose?: string; interrupted?: string | null };
export type Lease = {
  name: string;
  holder: { sid: string; human: boolean; purpose: string; description: string; describedAt: number; note: string; since: number; expiresAt: number | null; expiresInSeconds: number | null } | null;
  queue: { position: number; sid: string; purpose: string; description: string; describedAt: number; enqueuedAt: number; interrupted: boolean }[];
  log: LeaseEvent[];
};
export type State = {
  environments: Record<string, { keys?: string[] }>;
  repos: { name: string; url: string }[];
  sessions: Session[];
  leases?: Lease[]; // shared-device leases: who holds each device and who is queued
  sessionImage: string | null;
  flyError: string | null;
  fly?: FlyAccount | null; // the whole Fly account, scanned by Jarvis (cached ~1 min)
  loadError?: string | null; // client-side: the last api/state fetch failed (offline, tunnel down, signed out)
  loaded?: boolean; // client-side: api/state has answered at least once (before that, repos/environments are just unknown, not empty)
  hasCreds: boolean;
  creds?: { stale?: boolean; error?: string; expiresAt?: string; subscriptionType?: string };
  auth?: { unavailable?: boolean };
  version?: string; flyApp?: string;
};
// api/usage: one entry per rate-limit window, `percent` = share USED (remaining = 100 - percent)
export type UsageLimit = { kind: string; group: string; percent: number; severity?: string; resetsAt: string | null; model: string | null; surface: string | null; active: boolean };
export type Usage = {
  fetchedAt: string; cached?: boolean; stale?: boolean; error?: string;
  limits: UsageLimit[];
  extraUsage: { enabled: boolean; monthlyLimit: number; usedCredits: number; utilization: number; currency: string; decimalPlaces: number; disabledReason?: string | null; spendLimitReached: boolean } | null;
};
export type GhRepo = { fullName: string; url: string; htmlUrl: string; description?: string; language?: string; private?: boolean; fork?: boolean; archived?: boolean; pushedAt?: string };

export const REGION: Record<string, string> = { arn: "Stockholm", fra: "Frankfurt", ams: "Amsterdam", lhr: "London", cdg: "Paris", waw: "Warsaw", mad: "Madrid", iad: "Virginia", ord: "Chicago", sjc: "San Jose", lax: "Los Angeles", sin: "Singapore", nrt: "Tokyo", hkg: "Hong Kong", syd: "Sydney" };
export function ago(iso: string | Date) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now"; if (s < 3600) return Math.floor(s / 60) + " min ago"; if (s < 86400) return Math.floor(s / 3600) + " h ago"; return Math.floor(s / 86400) + " d ago";
}
// what the Claude app shows: the live server-side conversation title (fetched from the code-sessions
// API — always matches the phone, incl. renames done in the app) wins for a running session;
// otherwise a name you pinned/renamed, then the local AI-generated title (a paused session's comes
// from its snapshot transcript), then the creation name until it has booted.
export function fromNow(iso: string | Date) { const d = new Date(iso).getTime() - Date.now(); return d < 0 ? ago(iso) : "in " + ago(new Date(Date.now() - d)).replace(" ago", "").replace("just now", "a moment"); }
export function sessionTitle(m: Session) {
  return m.serverTitle || ((m.liveName && m.nameSource && m.nameSource !== "derived") ? m.liveName : (m.aiTitle || m.label || m.liveName || m.name));
}

// ---- transcript search (api/search — relayed to the search service) ----
export type SearchHit = {
  id: number; score: number; via: ("keyword" | "semantic")[]; kind: "msg" | "tool" | "doc"; date: string | null; ts: string | null;
  title: string; sid: string | null; dir: string | null; state: "archive" | "paused" | "live"; machineId: string | null; file: string; snippet: string;
};
export type SearchGroup = { title: string; sid: string | null; dir: string | null; state: SearchHit["state"]; machineId: string | null; date: string | null; count: number; hits: SearchHit[] };
export type SearchResult = { query: string; reranked: boolean; total: number; tookMs: number; notes: string[]; terms: string[]; hits?: SearchHit[]; sessions?: SearchGroup[] };
export type ContextChunk = { id: number; kind: SearchHit["kind"]; ts: string | null; text: string; hit?: boolean };
export type SearchContext = { session: { title: string; dir: string | null } | null; file: string; chunks: ContextChunk[] };

// ---- tasks (api/tasks — lib/tasks.js): script templates, their instances, runs, daily schedules ----
export type TaskField = { name: string; label: string; type: "text" | "textarea" | "number" | "select" | "multiselect" | "checkbox"; required: boolean; default?: unknown; options?: { value: string; label: string; sub?: string }[]; optionsFrom?: string; help?: string; placeholder?: string };
export type TaskTemplate = { name: string; title: string; description?: string; run?: string; stores?: string[]; image?: string; timeoutSeconds?: number; memory?: string; fields: TaskField[]; files: string[]; source?: string; error?: string };
export type TaskRunPhase = "starting" | "running" | "succeeded" | "failed" | "timedout" | "stopped";
export type TaskRun = { name: string; instance: string; template: string; trigger: "manual" | "schedule"; schedule: string | null; slot: string | null; instanceName: string; phase: TaskRunPhase; createdAt: string | null; startedAt: string | null; finishedAt: string | null; reason: string | null; exitCode?: number; waiting?: string };
export type TaskInstance = { id: string; template: string; name: string; params: Record<string, unknown>; hidden?: string[]; hiddenSet?: string[]; createdAt: string; updatedAt?: string; lastRun: TaskRun | null; schedules: number };
export type TaskSchedule = { id: string; instance: string; time: string; tz: string; enabled: boolean; since: number; createdAt: string; nextAt: number | null };
export type TasksOverview = { taskImage: string | null; templates: TaskTemplate[]; instances: TaskInstance[]; schedules: TaskSchedule[] };
export const RUN_ACTIVE = (p: TaskRunPhase) => p === "starting" || p === "running";
