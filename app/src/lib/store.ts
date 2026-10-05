// One external store for everything the dashboard polls, read from components with
// useSyncExternalStore. Nothing in here is optimistic: cards only change when the server
// reports the new state; in-flight actions show as PENDING labels on their buttons.
import { useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import { api, RUN_ACTIVE, type State, type PrevSession, type TasksOverview } from "./api";

export type Tab = "sessions" | "search" | "previous" | "tasks" | "schedules" | "devices" | "envs" | "content" | "repos" | "settings";
export const TABS: [Tab, string][] = [["sessions", "Sessions"], ["search", "Search"], ["previous", "Previous"], ["tasks", "Tasks"], ["schedules", "Schedules"], ["devices", "Devices"], ["envs", "Envs"], ["content", "Content"], ["repos", "Repos"], ["settings", "Settings"]];
// destroyed sessions (api/records): loaded when the Previous tab opens, not part of the 15 s poll
export type PreviousState = { loading: boolean; loaded: boolean; records: PrevSession[]; err: string | null };
// tasks + schedules (api/tasks): loaded while the Tasks or Schedules tab (or a task page) is open
export type TasksState = { loading: boolean; loaded: boolean; data: TasksOverview; err: string | null };
// content stores (api/content): loaded when the Content tab or the New Session form opens
export type ContentStore = { name: string; files: number; bytes: number };
export type ContentState = { loading: boolean; loaded: boolean; stores: ContentStore[]; err: string | null };
export type Toast = { id: number; text: string; kind: "info" | "ok" | "error" };
// a New Session create in flight, shown as a card until the real session appears in api/state:
// creating → (retrying: the reply was lost, re-sent with the same requestId, which Jarvis
// de-duplicates) → the real card | failed (with the reason; dismissed from the card)
export type Creating = { requestId: string; title: string; phase: "creating" | "retrying" | "failed"; error?: string; id?: string };
// a pending yes/no question, shown as a centered dialog (App renders it); resolve gets the answer.
// With `input` the question also carries an optional text box (askText): a text box inside the same
// dialog (`heading` is its title).
// `match`: a one-line box that must hold exactly this text before the action is enabled (a
// type-the-name guard for an irreversible action)
export type AskInput = { heading: string; label: string; placeholder?: string; note?: string; max?: number; match?: string };
// `check`: an on/off switch in the dialog (e.g. Start with or without the API proxy), answered with it
export type AskCheck = { label: string; sub?: string; on: boolean };
export type Confirm = { title: string; detail?: string; action: string; danger?: boolean; input?: AskInput; check?: AskCheck; resolve: (ok: boolean, text: string, checked: boolean) => void };
type Store = {
  state: State; tab: Tab; pending: Map<string, string>; previous: PreviousState; tasks: TasksState; content: ContentState; toasts: Toast[]; confirm: (Confirm & { id: number }) | null;
  sizes: { sizes: Record<string, { label: string }>; default: string };
  models: { models: Record<string, { label?: string; harness?: string }>; default: string; harnesses?: Record<string, { label: string; detail?: string }> };
  refreshing: boolean;
  creating: Creating[];
};
const S: Store = {
  state: { environments: {}, repos: [], sessions: [], sessionImage: null, flyError: null, hasCreds: true, auth: {} },
  tab: "sessions", pending: new Map(),
  previous: { loading: false, loaded: false, records: [], err: null },
  tasks: { loading: false, loaded: false, data: { taskImage: null, templates: [], instances: [], schedules: [] }, err: null },
  content: { loading: false, loaded: false, stores: [], err: null },
  sizes: { sizes: {}, default: "medium" }, models: { models: {}, default: "claude-opus-5-5" }, refreshing: false, toasts: [], confirm: null, creating: [],
};
const listeners = new Set<() => void>();
let snap = { ...S };
function emit() { snap = { ...S }; listeners.forEach((l) => l()); }
export function useStore<T>(sel: (s: Store) => T): T {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => sel(snap), () => sel(snap));
}
export const getStore = () => snap;

export function setTab(t: Tab) { S.tab = t; emit(); if (t === "previous" || t === "search") loadPrevious(); if (t === "tasks" || t === "schedules") loadTasks(); if (t === "content") loadContent(); }
export function pend(key: string, label: string | null) { label ? S.pending.set(key, label) : S.pending.delete(key); S.pending = new Map(S.pending); emit(); }

// ---- notices: no alert()/confirm() — toasts at the bottom of the screen, questions as dialogs ----
let toastSeq = 0;
export function toast(text: string, kind: Toast["kind"] = "info", ms = kind === "error" ? 8000 : 5000) {
  const id = ++toastSeq; S.toasts = [...S.toasts, { id, text, kind }]; emit();
  setTimeout(() => dismissToast(id), ms);
}
export function dismissToast(id: number) { if (S.toasts.some((t) => t.id === id)) { S.toasts = S.toasts.filter((t) => t.id !== id); emit(); } }
// Questions queue: a new ask() while one is up waits for it to be answered — it used to cancel the
// open one as "no" (a destroy check landing seconds later killed a Start prompt being typed).
let askSeq = 0;
const asks: (Confirm & { id: number })[] = [];
function enqueue(c: Confirm) { asks.push({ ...c, id: ++askSeq }); if (!S.confirm) { S.confirm = asks[0]; emit(); } }
/** Ask a yes/no question; resolves true when the action button is tapped, false on Cancel/dismiss. */
export function ask(q: Omit<Confirm, "resolve" | "input">): Promise<boolean> {
  return new Promise((resolve) => enqueue({ ...q, resolve: (ok) => resolve(ok) }));
}
/** A yes/no question with an optional text box; resolves the (trimmed, possibly empty) text, or null on Cancel/dismiss. */
export function askText(q: Omit<Confirm, "resolve"> & { input: AskInput }): Promise<string | null> {
  return new Promise((resolve) => enqueue({ ...q, resolve: (ok, text) => resolve(ok ? text.trim() : null) }));
}
/** askText plus the dialog's switch: resolves {text, checked}, or null on Cancel/dismiss. */
export function askTextCheck(q: Omit<Confirm, "resolve"> & { input: AskInput; check: AskCheck }): Promise<{ text: string; checked: boolean } | null> {
  return new Promise((resolve) => enqueue({ ...q, resolve: (ok, text, checked) => resolve(ok ? { text: text.trim(), checked } : null) }));
}
export function answer(ok: boolean, text = "", checked = false) {
  const c = S.confirm; if (!c) return;
  asks.shift(); S.confirm = asks[0] || null; emit(); c.resolve(ok, text, checked);
}

// ---- concurrency primitives ---------------------------------------------------------------
// Every read of server state goes through coalesce(): one request at a time, and a call while one
// is running gets ONE follow-up request that starts after it — never the running one, which was
// sent before the caller's change and would hand back the old state (a deleted env reappearing).
function coalesce(fn: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null, next: Promise<void> | null = null;
  const start = (): Promise<void> => (running = fn().finally(() => { running = null; }));
  return () => {
    if (!running) return start();
    const after = () => { next = null; return start(); };
    return (next ??= running.then(after, after));
  };
}
// Every user action runs under a key (a session's is "s:<id>"): one run per key at a time,
// whichever button, menu or page started it. A second start while one runs does nothing but say
// so, calmly — the buttons are already showing the running action, so this is rarely reached.
const actions = new Map<string, Promise<unknown>>();
export function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T | undefined> {
  const cur = actions.get(key);
  if (cur) { busyNote(S.pending.get(key)); return cur as Promise<T | undefined>; }
  const p = fn().finally(() => actions.delete(key));
  actions.set(key, p);
  return p;
}
export const running = (key: string) => actions.has(key);
// Jarvis refuses an action on a session that is in the middle of another one (409 with
// `busy: {kind}`): not an error — say what it is doing and that this can run afterwards.
export const BUSY_LABEL: Record<string, string> = { starting: "Starting…", restarting: "Restarting…", pausing: "Pausing…", destroying: "Destroying…", mode: "Switching mode…", env: "Updating secrets…", snapshotting: "Snapshotting…" };
function busyNote(label?: string) { toast(label ? `Still ${label.replace(/…$/, "").toLowerCase()} — this can run once that finishes.` : "Still busy with the last action — this can run once that finishes.", "info"); }
/** Toast an action's failure: a busy refusal as a calm note, anything else as an error. */
export function failed(e: any, prefix = "") {
  if (e?.status === 409 && e.busy) busyNote(BUSY_LABEL[e.busy.kind] || e.busy.kind);
  else toast(prefix + (e?.message || String(e)), "error");
}
/** Poll api/state until pred holds (or maxMs passes). */
export async function refreshUntil(pred: (s: State) => boolean, maxMs: number) {
  const until = Date.now() + maxMs;
  while (Date.now() < until) { await refresh(false); if (pred(S.state)) return true; await new Promise((r) => setTimeout(r, 1000)); }
  return false;
}

// ---- polling: 15s idle, 2s while something is settling ----------------------------------
let fastUntil = 0;
const SETTLERS: { pred: (s: State) => boolean; until: number }[] = [];
const pollState = coalesce(async () => {
  try { const st = await api<State>("GET", "api/state"); S.state = { ...st, flyError: st.flyError || null, loaded: true }; }
  catch (e: any) { S.state = { ...S.state, loadError: e.message }; }
  S.refreshing = false; emit();
});
// The state the returned promise resolves on was requested AFTER this call (see coalesce).
export function refresh(manual = false): Promise<void> {
  if (manual) { S.refreshing = true; emit(); if (S.tab === "previous") loadPrevious(); if (S.tab === "tasks" || S.tab === "schedules") loadTasks(true); if (S.tab === "content") loadContent(true); }
  return pollState();
}
// Run an action and keep its button in the pending state until the server CONFIRMS the
// outcome (pred), polling every second up to maxMs — the UI never flips back to the old
// state in between (Fly's list API lags a metadata/state change by a few seconds).
// Exclusive per key, so a second tap (or the same action from another page) never runs it twice.
export function pendUntil(key: string, label: string, action: () => Promise<unknown>, pred: (s: State) => boolean, maxMs = 30000) {
  return exclusive(key, async () => {
    pend(key, label);
    try { await action(); await refreshUntil(pred, maxMs); }
    catch (e: any) { failed(e); await refresh(false); }
    finally { pend(key, null); }
  });
}
// ---- creating a session -------------------------------------------------------------------
function setCreating(requestId: string, patch: Partial<Creating> | null) {
  S.creating = patch ? S.creating.map((c) => (c.requestId === requestId ? { ...c, ...patch } : c)) : S.creating.filter((c) => c.requestId !== requestId);
  emit();
}
export const dismissCreating = (requestId: string) => setCreating(requestId, null);
// No reply at all, or the tunnel's gateway errors: the create may well have happened, so it is
// re-sent with the same requestId (Jarvis answers the first result, never a second machine).
const AMBIGUOUS = (e: any) => !e.status || [502, 503, 504, 520, 522, 524].includes(e.status);
export async function createSession(requestId: string, title: string, body: Record<string, unknown>) {
  if (S.creating.some((c) => c.requestId === requestId && c.phase !== "failed")) return;
  S.creating = [{ requestId, title, phase: "creating" }, ...S.creating.filter((c) => c.requestId !== requestId)]; emit();
  let r: any = null, lastErr: any = null;
  for (let attempt = 0; attempt < 6 && !r; attempt++) {
    if (attempt) await new Promise((res) => setTimeout(res, Math.min(15000, 3000 * attempt)));
    try { r = await api("POST", "api/sessions", { ...body, requestId }); }
    catch (e: any) {
      lastErr = e;
      if (!AMBIGUOUS(e)) break;
      setCreating(requestId, { phase: "retrying", error: e.message });
    }
  }
  if (!r) {
    // the list may already show it (made on an earlier try whose reply got lost): that's success
    await refresh(false);
    const made = (S.state.sessions || []).find((m) => m.createRequestId === requestId);
    if (made) { setCreating(requestId, null); settle((s) => { const m = (s.sessions || []).find((x) => x.id === made.id); return !!(m && m.state === "started" && m.status); }); return; }
    setCreating(requestId, { phase: "failed", error: lastErr?.message || "no response from Jarvis" });
    // only while the viewer is still on the list — never yank them off whatever they moved on to
    if (/Re-login/.test(lastErr?.message || "") && S.tab === "sessions") setTab("settings");
    return;
  }
  setCreating(requestId, { phase: "creating", error: undefined, id: r.id });
  await refresh(false);
  // the placeholder gives way to the real card as soon as api/state lists it
  const until = Date.now() + 120000;
  while (Date.now() < until && !(S.state.sessions || []).some((m) => m.id === r.id)) { await new Promise((res) => setTimeout(res, 2000)); await refresh(false); }
  setCreating(requestId, null);
  settle((s) => { const m = (s.sessions || []).find((x) => x.id === r.id); return !!(m && m.state === "started" && m.status); }); // fast-poll until claude is actually up
}

// poll fast until predicate(state) is true or maxMs elapses
export function settle(pred: (s: State) => boolean, maxMs = 90000) { fastUntil = Math.max(fastUntil, Date.now() + maxMs); SETTLERS.push({ pred, until: Date.now() + maxMs }); }
// Idle cadence is measured from the last poll, not "the current second is a multiple of 15":
// a 2 s interval samples only every other second, so that test used to fire every 30 s at best.
// Nothing polls until the app is signed in (start(), from the root layout).
let lastPoll = 0, started = false;
export function start() {
  if (started) return; started = true;
  setInterval(async () => {
    const fast = Date.now() < fastUntil;
    if (fast || Date.now() - lastPoll >= 15000) { lastPoll = Date.now(); await refresh(false); }
    // a restore Jarvis is running (started here or on another device): follow its phase
    if (S.tab === "previous" && S.previous.records.some((r) => r.restore && !["done", "failed"].includes(r.restore.phase))) loadPrevious();
    // tasks: every 15 s while their tab is open, every 2 s while a run is starting/running
    if ((S.tab === "tasks" || S.tab === "schedules") && (Date.now() - tasksAt >= 15000 || S.tasks.data.instances.some((i) => i.lastRun && RUN_ACTIVE(i.lastRun.phase)))) loadTasks();
    for (let i = SETTLERS.length - 1; i >= 0; i--) { const s = SETTLERS[i]; if (s.pred(S.state) || Date.now() > s.until) SETTLERS.splice(i, 1); }
    if (!SETTLERS.length) fastUntil = 0;
  }, 2000);
  // back in the foreground (phone unlocked, app switched to): refresh at once instead of waiting
  // for the next 15 s tick — this is also where an expired login gets noticed
  AppState.addEventListener("change", (st) => { if (st === "active") refresh(false); });
  api("GET", "api/sizes").then((j) => { S.sizes = j; emit(); }).catch(() => {});
  api("GET", "api/models").then((j) => { S.models = j; emit(); }).catch(() => {});
  refresh(true);
}

export const loadPrevious = coalesce(async () => {
  S.previous = { ...S.previous, loading: true }; emit();
  try { const j = await api<{ records: PrevSession[] }>("GET", "api/records"); S.previous = { ...S.previous, records: j.records || [], err: null, loaded: true }; }
  catch (e: any) { S.previous = { ...S.previous, err: e.message }; }
  S.previous = { ...S.previous, loading: false }; emit();
});

let contentFresh = false;
const pollContent = coalesce(async () => {
  S.content = { ...S.content, loading: true }; emit();
  try { const j = await api<{ stores: ContentStore[] }>("GET", "api/content" + (contentFresh ? "?fresh=1" : "")); S.content = { ...S.content, stores: j.stores || [], err: null, loaded: true }; }
  catch (e: any) { S.content = { ...S.content, err: e.message }; }
  contentFresh = false;
  S.content = { ...S.content, loading: false }; emit();
});
/** Reload api/content; `fresh` skips Jarvis's one-minute listing cache. */
export function loadContent(fresh = false) { if (fresh) contentFresh = true; return pollContent(); }

let tasksAt = 0, tasksFresh = false;
const pollTasks = coalesce(async () => {
  tasksAt = Date.now();
  S.tasks = { ...S.tasks, loading: true }; emit();
  try { const j = await api<TasksOverview>("GET", "api/tasks" + (tasksFresh ? "?refresh=1" : "")); S.tasks = { ...S.tasks, data: j, err: null, loaded: true }; }
  catch (e: any) { S.tasks = { ...S.tasks, err: e.message }; }
  tasksFresh = false;
  S.tasks = { ...S.tasks, loading: false }; emit();
});
/** Reload api/tasks; `fresh` also re-reads the templates from git (the ↻ button). */
export function loadTasks(fresh = false) { if (fresh) tasksFresh = true; return pollTasks(); }
/** Run an action, then reload tasks until pred holds (two-phase, like pendUntil for api/state). */
export function pendTasks(key: string, label: string, action: () => Promise<unknown>, pred: (d: TasksOverview) => boolean, maxMs = 20000) {
  return exclusive(key, async () => {
    pend(key, label);
    try {
      await action();
      const until = Date.now() + maxMs;
      while (Date.now() < until) { await loadTasks(); if (pred(S.tasks.data)) break; await new Promise((r) => setTimeout(r, 1000)); }
    } catch (e: any) { failed(e); await loadTasks(); }
    finally { pend(key, null); }
  });
}

// read hooks for the browser test (test/dashboard.test.js)
if (Platform.OS === "web" && typeof window !== "undefined") {
  (window as any).getState = () => S.state;
  (window as any).__refresh = () => refresh(false);
  (window as any).__ask = ask;
}
