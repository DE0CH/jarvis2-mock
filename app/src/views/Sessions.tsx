import { useRef, useState } from "react";
import { View } from "react-native";
import { api, ago, REGION, sessionTitle, type Lease, type SearchHit, type Session, type State } from "../lib/api";
import { useStore, getStore, pend, refresh, refreshUntil, settle, setTab, ask, askText, askTextCheck, toast, failed, exclusive, dismissCreating, BUSY_LABEL, type Creating } from "../lib/store";
import { Box, Button, Callout, CalloutText, Card, Flex, Heading, Lbl, Muted, P, Pill, Text } from "../ui/kit";
import { BusyButton, LastMessage, PButton, useCoolAfterShift } from "../ui/bits";
import { Cards } from "../ui/cards";
import { openMenu, mouse, type MenuItem } from "../ui/overlays";
import { useTranscriptMatches, metaMatch, TabSearchBox, CardHits } from "./TabSearch";

// What Jarvis is doing to this session right now, as a button label ("Starting…"), from its
// lock or its running start/destroy job — seen on every device, not just the one that started it.
// While set, the card's actions are replaced by that label: a clashing action is never offered.
export function serverBusy(m: Session): string | null {
  if (m.busy) return BUSY_LABEL[m.busy.kind] || "Working…";
  if (m.destroy && !["done", "failed"].includes(m.destroy.phase)) return m.destroy.phase === "destroying" ? "Destroying…" : "Archiving…";
  if (m.wake && !["done", "failed"].includes(m.wake.phase)) return WAKE_LABEL[m.wake.phase] || "Working…";
  return null;
}
function SessionPill({ m }: { m: Session }) {
  // Real state only. Fly state first; then whether claude inside has actually come up.
  if (m.state === "destroying" || m.state === "destroyed") return <Pill kind="bad" spin>{m.state}</Pill>;
  if (m.destroy && (m.destroy.phase === "archiving" || m.destroy.phase === "destroying")) return <Pill kind="bad" spin>{m.destroy.phase + "…"}</Pill>;
  if (m.state === "created" || m.state === "starting") return <Pill kind="wait" spin>creating…</Pill>;
  const sb = serverBusy(m);
  if (sb) return <Pill kind="wait" spin>{sb.toLowerCase()}</Pill>;
  if (m.state === "stopped" || m.state === "suspended") return hasSchedule(m) ? <Pill kind="info">scheduled</Pill> : <Pill kind="dim">paused</Pill>;
  if (m.state === "started") {
    if (m.oneShotDone) return <Pill kind="wait" spin>done · archiving…</Pill>;
    if (!m.status) return <Pill kind="wait" spin>booting…</Pill>;
    if (m.status === "busy") return <Pill kind="wait">working</Pill>;
    if (m.status === "waiting") return <Pill kind="bad">needs you</Pill>;
    return m.bgTasks ? <Pill kind="wait">{`idle · ${m.bgTasks} background`}</Pill> : <Pill kind="ok">idle</Pill>;
  }
  return <Pill kind="dim">{m.state}</Pill>;
}

const isPaused = (m: Session) => m.state === "stopped" || m.state === "suspended";
// armed to wake on its own: a one-off wakeup, a recurring one (cron) or a conditional one (watch)
const hasSchedule = (m: Session) => !!m.wakeup || !!(m.wakeups || []).length || !!(m.crons || []).length || !!(m.watches || []).length;
// order groups: running (up) → creating → paused → destroying (down). Newest-first within a group.
const sortRank = (m: Session) => m.state === "started" ? 0 : (m.state === "created" || m.state === "starting") ? 1 : isPaused(m) ? 2 : (m.state === "destroying" || m.state === "destroyed") ? 4 : 3;
// the headed sections of the list: a paused session that will wake on its own is not "just paused"
const GROUPS = ["Running", "Scheduled", "Paused"] as const;
const groupOf = (m: Session): typeof GROUPS[number] => sortRank(m) <= 1 ? "Running" : isPaused(m) && hasSchedule(m) ? "Scheduled" : "Paused";
const find = (s: any, id: string): Session | undefined => (s.sessions || []).find((x: Session) => x.id === id);

// ---- actions (never optimistic: the pending label stays until the server confirms) ----
// Wake-type actions (start, permission-mode switch) can run for minutes on the server — a
// snapshot upload, a config replace, start retries — longer than a request through the tunnel
// lives (~60 s). So the POST only starts a wake job (202) and the phase is followed at
// GET api/sessions/:id/wake — the pending label mirrors it — until the job ends; then the card
// stays pending until the session list actually shows the new state.
const WAKE_LABEL: Record<string, string> = { preparing: "Preparing…", snapshotting: "Snapshotting…", "rolling-back": "Rolling back…", switching: "Switching mode…", starting: "Starting…" };
async function waitWake(id: string): Promise<any> {
  const until = Date.now() + 15 * 60 * 1000;
  let misses = 0;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1000));
    let j: any;
    try { j = await api("GET", "api/sessions/" + id + "/wake"); misses = 0; }
    catch (e: any) { if (++misses >= 20) throw e; continue; }
    if (j.phase === "done" || j.phase === "failed" || j.phase === "none") return j;
    pend("s:" + id, WAKE_LABEL[j.phase] || "Working…");
  }
  throw new Error("the restart is taking more than 15 minutes — check the list later");
}
async function wakeVia(id: string, label: string, post: () => Promise<any>, pred: (s: State) => boolean, maxMs: number) {
  pend("s:" + id, label);
  try {
    await post();
    const j = await waitWake(id);
    if (j.phase === "failed") throw new Error(j.error || "restart failed");
    if (j.phase === "none") console.warn("Jarvis lost track of the wake job (it restarted?) — watching the session state instead");
    pend("s:" + id, label);
    const until = Date.now() + maxMs;
    while (Date.now() < until) { await refresh(false); if (pred(getStore().state)) break; await new Promise((r) => setTimeout(r, 1000)); }
  } catch (e: any) { failed(e); await refresh(false); }
  finally { pend("s:" + id, null); }
}
// the API proxy switch of New session / Start / Restore (session-image/api-proxy.js)
export const API_PROXY_CHECK = { label: "API proxy", sub: "Logs every request to and response from the Anthropic API into ~/artifacts/api-log, archived with the session." };
// the optional prompt of a Start / Restore: typed into the session once Claude has resumed
export const RESUME_PROMPT = { label: "Prompt (optional)", placeholder: "What Claude should do once it is back — typed into the session as your next message. Leave blank to just bring it back.", max: 4000 };
// Start asks first: the question carries the optional resume prompt (blank = a plain resume).
// Every session action runs exclusive("s:<id>"), question included: the card, its menu, the
// transcript page and a search hit can all start one, and only the first gets to.
export const wakeSession = (id: string) => exclusive("s:" + id, async () => {
  const m = find(getStore().state, id);
  const a = await askTextCheck({ title: `Start “${m ? sessionTitle(m) : id}”?`, detail: "Resumes the same conversation, with the files as they were when it was paused.", action: "Start", input: { heading: "Start session", ...RESUME_PROMPT },
    check: { ...API_PROXY_CHECK, on: m?.apiProxy === "on" } });
  if (a === null) return;
  const prompt = a.text;
  await wakeVia(id, "Starting…", () => api("POST", "api/sessions/" + id + "/start", { ...(prompt ? { prompt } : {}), apiProxy: a.checked }), (s) => { const m = find(s, id); return !!m && m.state === "started"; }, 60000);
  settle((s) => { const m = find(s, id); return !!(m && m.state === "started" && m.status); });
});
// every scheduled wakeup; an older jarvis only reports the one `wakeup`
const wakeupsOf = (m: Session) => m.wakeups || (m.wakeup ? [{ name: "default", ...m.wakeup }] : []);
const wakeupLabel = (name: string) => name === "default" ? "" : ` “${name}”`;
// "daily" / "every 6 h" / "every 3 d"
function cronEvery(sec: number) {
  return sec === 86400 ? "daily" : sec === 604800 ? "weekly" : sec % 86400 === 0 ? `every ${sec / 86400} d` : sec % 3600 === 0 ? `every ${sec / 3600} h` : `every ${Math.round(sec / 60)} min`;
}
// "every 5 min" / "every 2 h" for a watch's check interval
function watchEvery(sec: number) {
  return sec < 120 ? `every ${sec} s` : sec % 3600 === 0 ? `every ${sec / 3600} h` : `every ${Math.round(sec / 60)} min`;
}
const clip = (t: string) => t.length > 90 ? t.slice(0, 90) + "…" : t;
// what will wake this session, one line each — a blue box so a scheduled session reads as such at a glance
function Schedules({ m }: { m: Session }) {
  if (!hasSchedule(m)) return null;
  const lines: [string, string, string][] = [];
  for (const w of wakeupsOf(m)) lines.push(["wakeup:" + w.name, `Wakes${wakeupLabel(w.name)} ${wakeupWhen(w.at)}`, w.prompt]);
  for (const c of m.crons || []) lines.push(["cron:" + c.name, `Repeats ${cronEvery(c.everySeconds)}, next ${wakeupWhen(c.nextAt)}`, c.prompt]);
  for (const w of m.watches || []) lines.push(["watch:" + w.name, `Watching “${w.name}” ${watchEvery(w.interval)}, until ${wakeupWhen(Date.parse(w.expiresAtIso))}; ${watchLast(w)}`, w.prompt]);
  return (
    <Callout color="blue" variant="surface" mt={2} data={{ schedules: "1" }}>
      {lines.map(([k, when, prompt]) => <CalloutText key={k} color="blue"><Text weight="medium">{when}</Text> — “{clip(prompt)}”</CalloutText>)}
    </Callout>
  );
}
// the watch's last check, as Jarvis saw it since its last restart
function watchLast(w: NonNullable<Session["watches"]>[number]) {
  if (!w.lastRunIso) return "no check since Jarvis started";
  const hm = new Date(w.lastRunIso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const verdict = w.lastExit === 1 ? "not yet" : w.lastExit === 0 ? "met" : `failed (exit ${w.lastExit}${w.lastError ? ": " + w.lastError : ""})`;
  return `last check ${hm}, ${verdict}`;
}
// "at 07:52" / "tomorrow at 07:52" in the viewer's local time
function wakeupWhen(at: number) {
  const d = new Date(at), now = new Date();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sameDay = d.toDateString() === now.toDateString();
  const mins = Math.round((at - Date.now()) / 60000);
  const rel = mins < 1 ? "now" : mins < 120 ? `in ~${mins} min` : mins < 48 * 60 ? `in ~${Math.round(mins / 60)} h` : `in ~${Math.round(mins / 1440)} d`;
  return `${sameDay ? "at " + hm : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + hm} (${rel})`;
}
// Session says "Login expired · Please run /login" (another session rotated the shared refresh
// token): write Jarvis's current pair into the session and type "continue" so it resumes.
export const reloginSession = (id: string) => exclusive("s:" + id, async () => {
  pend("s:" + id, "Refreshing login…");
  try { const r = await api("POST", "api/sessions/" + id + "/relogin", { text: "continue" }); toast("Fresh credentials written into the session" + (r.prompted ? " and “" + r.text + "” sent" : "") + ". Valid until " + new Date(r.expiresAt).toLocaleString() + ".", "ok"); }
  catch (e: any) { failed(e, "Refresh login failed: "); if (/Re-login/.test(e.message) && getStore().tab === "sessions") setTab("settings"); }
  await refresh(false); pend("s:" + id, null);
});
// Poll a destroy job until it is done/failed (or Jarvis no longer knows it). Network blips
// while polling are tolerated (the job runs server-side regardless); the pending label follows
// the phase. Gives up after 15 min.
async function waitDestroy(id: string): Promise<any> {
  const until = Date.now() + 15 * 60 * 1000;
  let misses = 0;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1000));
    let j: any;
    try { j = await api("GET", "api/sessions/" + id + "/destroy"); misses = 0; }
    catch (e: any) { if (++misses >= 20) throw e; continue; }
    if (j.phase === "done" || j.phase === "failed" || j.phase === "none") return j;
    pend("s:" + id, j.phase === "destroying" ? "Destroying…" : "Archiving…");
  }
  throw new Error("destroy is taking more than 15 minutes — check the list later");
}
export const destroySession = (id: string) => exclusive("s:" + id, async () => {
  pend("s:" + id, "Checking…");
  let msg = "";
  try {
    const c = await api("GET", `api/sessions/${id}/changes`);
    if (c.checked) {
      const dirty = (c.repos || []).filter((r: any) => r.uncommitted > 0 || r.unpushed > 0 || r.unpushed === -1);
      if (c.status === "busy") msg += "⚠️ Claude is still WORKING in this session.\n\n";
      if (dirty.length) {
        msg += "⚠️ Unsaved work will be LOST:\n" + dirty.map((r: any) => "• " + r.name + ": "
          + (r.uncommitted > 0 ? r.uncommitted + " uncommitted file(s)" : "")
          + (r.uncommitted > 0 && (r.unpushed > 0 || r.unpushed === -1) ? ", " : "")
          + (r.unpushed > 0 ? r.unpushed + " unpushed commit(s)" : r.unpushed === -1 ? "branch has no upstream (nothing pushed)" : "")).join("\n") + "\n";
      } else if (c.status !== "busy") msg += "✓ No uncommitted or unpushed changes found" + (c.paused ? " (as of when it was paused)" : "") + ".\n";
    } else msg += "⚠️ Could not check for unsaved changes (" + (c.reason || "unknown") + ").\n";
  } catch { msg += "⚠️ Could not check for unsaved changes.\n"; }
  msg += "\nTranscripts and ~/artifacts are archived to the Storage Box first; then the container is deleted. Your repos on GitHub are not affected.";
  // Keep the "Checking…" spinner up until the question is answered: clearing it before ask()
  // leaves a gap before the dialog is up, which reads as broken.
  const ok = await ask({ title: "Destroy this session?", detail: msg, action: "Destroy session", danger: true });
  pend("s:" + id, null);
  if (!ok) return;
  pend("s:" + id, "Archiving…");
  try {
    // DELETE only starts the job (202) — archiving can take minutes, longer than a request through
    // the tunnel is allowed to live — so follow it via its status endpoint until it ends.
    await api("DELETE", "api/sessions/" + id);
    let j = await waitDestroy(id);
    if (j.phase === "failed" && j.archiveFailed) {
      if (!(await ask({ title: "Archiving to the Storage Box failed", detail: (j.error || "") + "\n\nDestroy anyway? The records will be lost.", action: "Destroy anyway", danger: true }))) { pend("s:" + id, null); return; }
      pend("s:" + id, "Destroying…");
      await api("DELETE", "api/sessions/" + id + "?force=1");
      j = await waitDestroy(id);
    }
    if (j.phase === "failed") throw new Error(j.error || "destroy failed");
    if (j.phase === "none") throw new Error("Jarvis lost track of the destroy (it restarted?) — check the list and try again");
  } catch (e: any) { failed(e); }
  // stay pending until the list itself shows it going (destroying/destroyed) or gone
  await refreshUntil((st) => { const m = find(st, id); return !m || m.state === "destroying" || m.state === "destroyed"; }, 20000);
  pend("s:" + id, null);
  settle((st) => !(st.sessions || []).some((x) => x.id === id), 60000);
});

// A New Session create still on its way (store.createSession): stands in for the session's card
// until api/state lists it, so a slow or dropped reply never leaves the list looking unchanged.
function CreatingCard({ c }: { c: Creating }) {
  return (
    <Card data={{ creating: c.requestId }}>
      <Flex justify="space-between" align="flex-start" gap={2} mb={1}>
        <Heading size={3} style={{ flex: 1 }}>{c.title}</Heading>
        {c.phase === "failed" ? <Pill kind="bad">not created</Pill> : <Pill kind="wait" spin>{c.phase === "retrying" ? "checking…" : "creating…"}</Pill>}
      </Flex>
      {c.phase === "creating" && <Muted>{c.id ? "Created — loading the session list." : "Creating the machine…"}</Muted>}
      {c.phase === "retrying" && <Muted>Request failed ({c.error}). Retrying — the retry reuses this request's ID, so it cannot start a second session.</Muted>}
      {c.phase === "failed" && <>
        <P size={2} color="red" mt={1}>{c.error}</P>
        <Flex mt={2}><Button size={1} variant="soft" color="gray" onPress={() => dismissCreating(c.requestId)}>Dismiss</Button></Flex>
      </>}
    </Card>
  );
}

// Shared devices this session holds or waits for (details: the Devices tab).
function DeviceLine({ sid, leases }: { sid: string; leases: Lease[] }) {
  const held = leases.filter((l) => l.holder && l.holder.sid === sid);
  const waiting = leases.flatMap((l) => l.queue.filter((w) => w.sid === sid).map((w) => ({ name: l.name, position: w.position })));
  if (!held.length && !waiting.length) return null;
  return (
    <Flex gap={1} wrap mt={1}>
      {held.map((l) => <Pill key={l.name} kind="info">{"holds " + l.name}</Pill>)}
      {waiting.map((w) => <Pill key={w.name} kind="wait">{`#${w.position} in line for ${w.name}`}</Pill>)}
    </Flex>
  );
}
// sessions the Claude app does not see: their primary action is the Remote page (web UI + login / pairing)
const hasRemote = (m: any) => m.harness === "opencode" || m.harness === "openclaw";
function menuItems(m: any): MenuItem[] {
  const items: MenuItem[] = [];
  if (m.state === "started" && m.harness !== "opencode") items.push({ label: "Refresh login", sub: "Write fresh Claude credentials into the session and send “continue”", onClick: () => reloginSession(m.id) });
  items.push({ label: "Destroy", sub: "Archive transcripts + ~/artifacts, then delete the machine", danger: true, onClick: () => destroySession(m.id) });
  return items;
}

function MoreButton({ m, cool }: { m: Session; cool: boolean }) {
  const ref = useRef<View>(null);
  return (
    <View ref={ref} collapsable={false}>
      <Button variant="soft" color="gray" disabled={cool} style={cool ? { opacity: 0.3 } : undefined} label="More actions" id={"more-" + m.id} onPress={() => openMenu(ref.current, menuItems(m))}>More ▾</Button>
    </View>
  );
}

export function Sessions({ onTerminal, onTranscript, onRemote, onOpenHit }: { onTerminal: (id: string, title: string) => void; onTranscript: (m: Session) => void; onRemote: (m: Session) => void; onOpenHit: (h: SearchHit, terms: string[]) => void }) {
  const sessions = useStore((s) => s.state.sessions) || [];
  const models = useStore((s) => s.models);
  const pending = useStore((s) => s.pending);
  const leasesState = useStore((s) => s.state.leases) || [];
  const [q, setQ] = useState("");
  const tm = useTranscriptMatches(q, { state: "live,paused" });
  // running first, then everything else; within each group newest-first so cards never swap between polls
  const list = [...sessions].sort((a, b) => sortRank(a) - sortRank(b) || String(b.created || "").localeCompare(String(a.created || "")) || String(a.id).localeCompare(String(b.id)));
  const cool = useCoolAfterShift(list.map((m) => m.id).join("|"));
  // a create whose session already shows in the list gives way to the real card — matched by the
  // form's requestId too, so a create whose reply got lost doesn't sit next to its own session
  const creating = useStore((s) => s.creating).filter((c) => !list.some((m) => m.id === c.id || m.createRequestId === c.requestId));
  if (!list.length && !creating.length) return <><P size={3} color="gray" align="center" mt={8} mb={8}>{"No sessions running.\n" + (mouse() ? "Click" : "Tap") + " “New session”."}</P><FlyAccountSection /></>;
  // the search box: by title / settings, or by what was said and done in the conversation (a
  // transcript hit carries the session id as machineId — .live/<id>, .paused/<id>)
  const hitsFor = new Map(tm.groups.filter((g) => g.machineId).map((g) => [g.machineId!, g]));
  const shown = tm.needle ? list.filter((m) => hitsFor.has(m.id) || metaMatch(tm.needle, [sessionTitle(m), m.environment, m.repos, m.name, m.label, m.model, m.last?.text])) : list;
  return (
    <>
      <TabSearchBox id="sessions-q" placeholder="Search running and paused sessions" q={q} setQ={setQ} m={tm} />
      {tm.needle && !shown.length && !tm.busy && <P size={3} color="gray" align="center" mt={6} mb={6}>Nothing matches “{tm.needle}”.</P>}
      {GROUPS.map((g) => {
        const inGroup = shown.filter((m) => groupOf(m) === g);
        const pre = g === "Running" && !tm.needle ? creating : [];
        if (!inGroup.length && !pre.length) return null;
        return <Box key={g} data={{ group: g }}><Lbl>{g}</Lbl><Cards>
          {pre.map((c) => <CreatingCard key={c.requestId} c={c} />)}
          {inGroup.map((m: any) => {
            const title = sessionTitle(m);
            const busy = pending.get("s:" + m.id) || serverBusy(m);
            const repos = m.repos ? m.repos.split(" ").map((u: string) => u.split("/").pop()!.replace(/\.git$/, "")).join(", ") : "";
            const modelName = m.model ? ((models.models[m.model] || {}).label || m.model) : "";
            const paused = isPaused(m);
            // auto-pause status line: off / counting down / generic; paused sessions explain Start
            const apInfo = paused ? (hasSchedule(m) ? "Paused — Jarvis starts it on schedule; Start resumes it now." : "Paused — Start resumes the same conversation.")
              : m.oneShot ? (m.state === "started" ? "One-shot — archived and destroyed automatically once its prompt is done." : "")
              : m.state === "started" ? (m.autoPause === "off" ? "Auto-pause off — stays running while idle."
                : (m.pauseInMs != null ? `Pauses in ~${Math.max(1, Math.round(m.pauseInMs / 60000))} min if still idle.` : "Auto-pauses after ~1h idle.")) : "";
            const line1 = [m.environment ? "env: " + m.environment : "", repos].filter(Boolean).join(" · ");
            return (
              <Card key={m.id} dim={!!busy} data={{ session: m.id }} style={{ flex: 1 }}>
                <Flex justify="space-between" align="flex-start" gap={2} mb={1}>
                  <Heading size={3} style={{ flex: 1 }}>{title}</Heading>
                  {/* status pills live together in the top-right corner, whatever the session's state */}
                  <Flex gap={1} wrap justify="flex-end" style={{ flexShrink: 0, maxWidth: "55%" }}><SessionPill m={m} />{!paused && hasSchedule(m) && <Pill kind="info">scheduled</Pill>}</Flex>
                </Flex>
                <Flex gap={1} wrap align="center">
                  {!!line1 && <Muted>{line1}</Muted>}
                  {m.permissionMode === "bypass" ? <><Muted>{line1 ? "·" : ""}</Muted><Pill kind="bad">skip perms</Pill></> : m.permissionMode ? <Muted>{(line1 ? "· " : "") + "auto"}</Muted> : null}
                  {m.oneShot && <><Muted>·</Muted><Pill kind="dim">one-shot</Pill></>}
                </Flex>
                <Muted>{[REGION[m.region] || m.region || "", m.guest || "", modelName, m.created ? "created " + ago(m.created) : ""].filter(Boolean).join(" · ")}</Muted>
                {!!apInfo && <Muted mt={1}>{apInfo}</Muted>}
                <DeviceLine sid={m.id} leases={leasesState} />
                {paused && m.last && <LastMessage last={m.last} />}
                {!!m.resumePrompt && <Muted mt={1}>{(paused ? "Prompt queued for the next start" : "Prompt queued — typed in once Claude has resumed") + " — “" + clip(m.resumePrompt) + "”"}</Muted>}
                <Schedules m={m} />
                {!!tm.needle && <CardHits g={hitsFor.get(m.id)} terms={tm.terms} onOpen={onOpenHit} />}
                <Flex gap={2} pt={3} style={{ marginTop: "auto" }} data={{ actions: "1" }}>
                  {/* an OpenCode / OpenClaw session is driven from its own app + web UI, so Remote is its primary action */}
                  {/* More holds only Refresh login and Destroy; every other session action is API-only (API.md) */}
                  {m.state === "started" && (hasRemote(m) ? <Button onPress={() => onRemote(m)}>Remote</Button> : <Button id={"term-" + m.id} onPress={() => onTerminal(m.id, title)}>Terminal</Button>)}
                  {paused && (busy ? <BusyButton color="green" label={busy} /> : <PButton pkey={"s:" + m.id} color="green" onPress={() => wakeSession(m.id)} label="Start" />)}
                  {paused && m.hasTranscript && !busy && <Button variant="soft" color="gray" onPress={() => onTranscript(m)}>Transcript</Button>}
                  {busy ? (!paused ? <BusyButton variant="soft" color="gray" label={busy} /> : null) : <MoreButton m={m} cool={cool} />}
                </Flex>
              </Card>
            );
          })}
        </Cards></Box>;
      })}
      <FlyAccountSection />
    </>
  );
}
// Everything on the Fly account that is not one of the sessions above — view only. The summary
// line is always there, so "nothing else is running" is something the page SAYS, not an absence.
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
function FlyAccountSection() {
  const fly = useStore((s) => s.state.fly);
  if (!fly) return null;
  const other = fly.other || [];
  return (
    <Box id="fly-account" style={{ marginTop: 24 }}>
      {other.length > 0 && (
        <>
          <Heading size={3} mb={1}>Also on Fly</Heading>
          <Muted>Not sessions, but on the same Fly account{other.some((o) => o.kind !== "app") ? " — and billed" : ""}.</Muted>
          <Cards mt={12}>
            {other.map((o) => (
              <Card key={o.kind + ":" + o.app + ":" + o.id} data={{ flyOther: o.kind }}>
                <Flex justify="space-between" align="flex-start" gap={2} mb={1}><Heading size={3} style={{ flex: 1 }}>{o.name || o.id}</Heading><Pill kind={o.kind === "app" ? "dim" : o.state === "started" || o.kind === "volume" ? "wait" : "dim"}>{o.state || o.kind}</Pill></Flex>
                <Muted>{o.kind}{o.kind === "app" ? "" : " · app " + o.app}{o.name && o.kind !== "app" ? " · " + o.id : ""}</Muted>
                <Muted>{[o.detail, REGION[o.region] || o.region, o.created ? "created " + ago(o.created) : ""].filter(Boolean).join(" · ")}</Muted>
              </Card>
            ))}
          </Cards>
        </>
      )}
      <P size={1} color="gray" align="center" mt={4} id="fly-summary">
        {fly.error ? `Could not check the rest of the Fly account: ${fly.error}`
          : `Fly account: ${plural(fly.apps, "app")} · ${plural(fly.machines, "machine")} · ${plural(fly.volumes, "volume")} — ${other.length ? plural(other.length, "item") + " outside the sessions" : "nothing outside the sessions"}.`}
      </P>
    </Box>
  );
}
