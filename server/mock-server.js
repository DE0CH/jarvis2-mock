#!/usr/bin/env node
// Jarvis 2 mock backend: the Jarvis 1 mock API (canned /api/*, from claude-env selfhost/jarvis/test/mock-server.js)
// plus a mock secrets-controller core (core.js, /core/*) that the iPhone shell's secure sheet talks to.
//   node server/mock-server.js [port]      HOST=0.0.0.0 to listen on every interface
const express = require("express");
const path = require("path");
const core = require("./core");
const app = express();
app.use(express.json());
const now = Date.now();
// New session is idempotent on requestId like Jarvis; see the __mock/drop-next-create hook
let dropNextCreate = 0, createCalls = 0;
const createdBy = new Map();
const sessions = [
  // m1 is a one-shot (its prompt is the whole job: no auto-pause, destroyed by Jarvis when done)
  { id: "m1", name: "s-weekly-report-ab12c", state: "started", status: "busy", region: "arn", created: new Date(now - 5 * 60000).toISOString(), environment: "default", repos: "https://github.com/DE0CH/claude-env.git", permissionMode: "auto", model: "claude-fable-5-1", autoPause: "off", oneShot: true, guest: "4×shared · 4 GB", label: "Weekly report", aiTitle: "Weekly Report Digest" },
  { id: "m2", name: "paused-one", state: "stopped", region: "fra", created: new Date(now - 3 * 3600000).toISOString(), environment: "default", repos: "https://github.com/DE0CH/claude-env.git https://github.com/DE0CH/wda-build.git", permissionMode: "bypass", model: "claude-opus-5-5", autoPause: "off", guest: "2×shared · 2 GB", label: "Long-running paused session with a rather long title", aiTitle: "", hasTranscript: true, last: { role: "assistant", text: "The 16:30 sailing from Shekou connects with 45 minutes to spare; the 17:45 is too tight for the 20:05 departure. I have not booked anything yet.", at: new Date(now - 2 * 3600000).toISOString() }, wakeup: { at: now + 47 * 60000, atIso: new Date(now + 47 * 60000).toISOString(), prompt: "Scheduled retry: re-test the juhe train API and report on Discord" }, wakeups: [{ name: "default", at: now + 47 * 60000, atIso: new Date(now + 47 * 60000).toISOString(), prompt: "Scheduled retry: re-test the juhe train API and report on Discord" }, { name: "hotel-busan", at: now + 3 * 86400000, atIso: new Date(now + 3 * 86400000).toISOString(), prompt: "Discord Deyao: the Busan hotel free cancellation ends in 1 hour" }] },
  // m3: paused, woken by a check script or a daily cron (Scheduled group); m4: plain paused (Paused group)
  { id: "m3", name: "ticket-watch", state: "stopped", region: "fra", created: new Date(now - 26 * 3600000).toISOString(), environment: "default", repos: "https://github.com/DE0CH/claude-env.git", permissionMode: "auto", model: "claude-opus-5-5", autoPause: "on", guest: "2×shared · 2 GB", label: "Ticket drop watch", aiTitle: "", hasTranscript: false,
    watches: [{ name: "yes24-drop", prompt: "Tickets are on sale: book two seats in block B", failPrompt: "", interval: 300, maxSeconds: 86400, armedAt: now - 3600000, armedAtIso: new Date(now - 3600000).toISOString(), expiresAtIso: new Date(now + 23 * 3600000).toISOString(), lastExit: 1, lastRunIso: null, runs: 12 }],
    crons: [{ name: "digest", prompt: "Post the daily price digest", everySeconds: 86400, tz: "UTC", nextAt: now + 5 * 3600000, nextAtIso: new Date(now + 5 * 3600000).toISOString(), until: null, untilIso: null, armedAtIso: new Date(now - 86400000).toISOString(), runs: 1, lastFiredIso: null }] },
  { id: "m4", name: "idle-paused", state: "stopped", region: "fra", created: new Date(now - 30 * 3600000).toISOString(), environment: "default", repos: "https://github.com/DE0CH/claude-env.git", permissionMode: "auto", model: "claude-opus-5-5", autoPause: "on", guest: "2×shared · 2 GB", label: "Hotel comparison", aiTitle: "", hasTranscript: false },
];
const pausedTail = (s) => { const t = (m) => new Date(now - 2 * 3600000 - m * 60000).toISOString();
  return { title: s.aiTitle || "", messages: [...Array(4).keys()].flatMap((i) => [{ role: "user", text: `Paused question ${i + 1}?`, at: t(60 - i * 8) }, { role: "assistant", text: `Paused answer ${i + 1} with a_very_long_unbroken_token_${"x".repeat(60)}.`, at: t(58 - i * 8) }]).concat(s.last ? [s.last] : []) }; };
app.get("/api/sessions/:id/tail", (req, res) => { const s = sessions.find((x) => x.id === req.params.id); if (!s) return res.status(404).json({ error: "no such session" }); if (s.state === "started") return res.status(409).json({ error: "the session is started, not paused" }); if (!s.hasTranscript) return res.status(404).json({ error: "this session has no pause snapshot" }); res.json(pausedTail(s)); });
// Test hook: delay /api/state by N ms (dashboard.test.js opens New session BEFORE the first state
// answer to check the form does not submit blanks). POST /api/_mock/state-delay {"ms": 1500}.
let stateDelay = 0, flyStray = false;
app.post("/api/_mock/fly-stray", (req, res) => { flyStray = !!req.body.on; res.json({ ok: true, on: flyStray }); });
app.post("/api/_mock/state-delay", (req, res) => { stateDelay = Number(req.body.ms) || 0; res.json({ ok: true, ms: stateDelay }); });
// shared devices: iphone held by m1 with a queue of two (m2 with a description), mac free, wechat-phone taken over by Deyao
const leases = [
  { name: "wechat-phone", holder: { sid: "deyao", human: true, purpose: "Deyao is using it himself", description: "", describedAt: now - 600000, note: "answering a message", since: now - 600000, expiresAt: null, expiresInSeconds: null }, queue: [], log: [] },
  { name: "iphone", holder: { sid: "m1", human: false, purpose: "Pay the Busan hotel in 支付宝", description: "Step 2 of 3: order created, opening 支付宝 to authorise with Face ID.\nThen: screenshot the receipt.", describedAt: now - 60000, note: "", since: now - 8 * 60000, expiresAt: now + 52 * 60000, expiresInSeconds: 52 * 60 },
    queue: [{ position: 1, sid: "m2", purpose: "WeChat 扫一扫 of the admin-verify QR on the Mac", description: "Needs the Mac to show the QR first (holding mac is not needed: the QR is a file).", describedAt: now - 4 * 60000, enqueuedAt: now - 4 * 60000, interrupted: false },
      { position: 2, sid: "m4", purpose: "Read an SMS code", description: "", describedAt: now - 60000, enqueuedAt: now - 60000, interrupted: false }],
    log: [{ at: now - 8 * 60000, kind: "granted", sid: "m1", purpose: "Pay the Busan hotel in 支付宝" }] },
  { name: "mac", holder: null, queue: [], log: [] },
];
app.get("/api/state", (req, res) => setTimeout(() => res.json({ version: "mock", flyApp: "de0ch-claude-sessions", hasCreds: true, creds: { expiresAt: new Date(now + 3600000).toISOString(), subscriptionType: "max" }, auth: {}, sessionImage: "ghcr.io/de0ch/claude-sessions:sha-mock", flyError: null,
  // the rest of the Fly account (view only): clean by default, one stray volume after POST api/_mock/fly-stray {on:true}
  fly: { apps: flyStray ? 2 : 1, machines: sessions.length, volumes: flyStray ? 1 : 0, error: null, checkedAt: new Date().toISOString(), other: flyStray ? [{ kind: "volume", app: "fly-builder-mock", id: "vol_mock1", name: "machine_data", state: "created", region: "arn", created: new Date(now - 5 * 86400000).toISOString(), detail: "50 GB · not attached" }] : [] },
  environments: Object.fromEntries(core.stores().map((x) => [x.name, { keys: x.keys, sensitive: x.sensitive }])),
  repos: [{ name: "claude-env", url: "https://github.com/DE0CH/claude-env.git" }, { name: "wda-build", url: "https://github.com/DE0CH/wda-build.git" }], sessions, leases }), stateDelay));
app.get("/api/usage", (req, res) => res.json({ fetchedAt: new Date().toISOString(), cached: false, limits: [
  { kind: "session", group: "session", percent: 8, severity: "normal", resetsAt: new Date(now + 2.5 * 3600000).toISOString(), model: null, surface: null, active: false },
  { kind: "weekly_all", group: "weekly", percent: 40, severity: "normal", resetsAt: new Date(now + 3 * 86400000).toISOString(), model: null, surface: null, active: false },
  { kind: "weekly_scoped", group: "weekly", percent: 83, severity: "warning", resetsAt: new Date(now + 3 * 86400000).toISOString(), model: "Fable", surface: null, active: true },
], extraUsage: { enabled: false, monthlyLimit: 20000, usedCredits: 0, utilization: 0, currency: "GBP", decimalPlaces: 2, disabledReason: "out_of_credits", spendLimitReached: false } }));
app.get("/api/sizes", (req, res) => res.json({ sizes: { small: { label: "2 shared vCPU / 2 GB" }, medium: { label: "4 shared vCPU / 4 GB" }, large: { label: "8 shared vCPU / 8 GB" } }, default: "medium" }));
app.get("/api/models", (req, res) => res.json({ models: { "claude-opus-5-5": { harness: "claude", label: "Opus 5.5" }, "claude-fable-5-1": { harness: "claude", label: "Fable 5.1" }, "openrouter/z-ai/glm-5.3": { harness: "opencode", label: "GLM 5.3 — $0.90 / $2.82" }, "openrouter/deepseek/deepseek-v4.1-flash": { harness: "opencode", label: "DeepSeek V4.1 Flash — $0.15 / $0.60" }, "openclaw/claude-opus-5-5": { harness: "openclaw", label: "Opus 5.5" }, "openclaw/claude-fable-5-1": { harness: "openclaw", label: "Fable 5.1" } }, default: "claude-opus-5-5", harnesses: { claude: { label: "Claude Code", detail: "Claude subscription · Claude app" }, opencode: { label: "OpenCode · OpenRouter", detail: "Paseo app + web UI" } } }));
const mockRemote = (s) => s.harness === "openclaw"
  ? { webUrl: "https://" + s.id + "-s.tunnel.example/#token=MOCK-GATEWAY-TOKEN", harness: "openclaw", url: "wss://" + s.id + "-s.tunnel.example", token: "MOCK-GATEWAY-TOKEN" }
  : { webUrl: "https://" + s.id + "-s.tunnel.example/", harness: "opencode", pairUrl: "https://app.paseo.sh/#offer=MOCK-OFFER", relay: true };
app.get("/api/sessions/:id/remote", (req, res) => {
  const s = sessions.find((x) => x.id === req.params.id);
  if (!s || !["opencode", "openclaw"].includes(s.harness)) return res.status(400).json({ error: "only OpenCode and OpenClaw sessions have a remote here" });
  res.json(mockRemote(s));
});
// what Deyao's OpenClaw / Paseo app builds list (same shape as server.js; POST /api/mock/opencode or
// /api/mock/openclaw adds a started session of that harness, POST /api/mock/paused-remote a paused one)
app.get("/api/remotes", (req, res) => {
  const harness = String(req.query.harness || "");
  if (!["opencode", "openclaw"].includes(harness)) return res.status(400).json({ error: "harness must be openclaw or opencode" });
  res.json({ sessions: sessions.filter((s) => s.harness === harness).map((s) => {
    const out = { id: s.id, title: s.label || s.aiTitle || s.name, state: s.state === "stopped" ? "paused" : s.state, model: s.model };
    if (out.state !== "started") return out;
    const r = mockRemote(s);
    return harness === "openclaw" ? { ...out, url: r.url, token: r.token, webUrl: r.webUrl } : { ...out, pairUrl: r.pairUrl };
  }) });
});
app.get("/api/github/repos", (req, res) => res.json({ repos: [
  { fullName: "DE0CH/claude-env", url: "https://github.com/DE0CH/claude-env.git", htmlUrl: "https://github.com/DE0CH/claude-env", description: "Claude environment", language: "JavaScript", private: true, pushedAt: new Date(now - 600000).toISOString() },
  { fullName: "DE0CH/other", url: "https://github.com/DE0CH/other.git", htmlUrl: "https://github.com/DE0CH/other", description: "Something else", language: "Python", pushedAt: new Date(now - 86400000).toISOString() },
] }));
let size = { cols: 120, rows: 40 };
app.post("/api/sessions/:id/tty/resize", (req, res) => { size = { cols: +req.body.cols, rows: +req.body.rows }; console.log("resize", size); res.json(size); });
app.post("/api/sessions/:id/tty/input", (req, res) => { console.log("input", JSON.stringify(req.body)); res.json({ ok: true }); });
app.get("/api/sessions/:id/tty/frame", (req, res) => {
  const lines = []; for (let r = 0; r < size.rows; r++) lines.push(r === 0 ? `╭${"─".repeat(size.cols - 2)}╮` : r === size.rows - 1 ? `╰${"─".repeat(size.cols - 2)}╯` : `│ line ${String(r).padStart(3)} ${"·".repeat(Math.max(0, size.cols - 12))} │`);
  res.json({ screen: lines.join("\n"), x: 3, y: 2, cols: size.cols, rows: size.rows, cursor: false });
});
app.post("/api/sessions/:id/wakeup", (req, res) => { const s = sessions.find((x) => x.id === req.params.id); if (!req.body.prompt) return res.status(400).json({ error: "prompt is required" }); const at = req.body.delaySeconds ? Date.now() + req.body.delaySeconds * 1000 : Date.parse(req.body.at); s.wakeup = { at, atIso: new Date(at).toISOString(), prompt: req.body.prompt }; res.json({ ok: true, wakeup: s.wakeup }); });
app.delete("/api/sessions/:id/watches/:name", (req, res) => { const s = sessions.find((x) => x.id === req.params.id); s.watches = (s.watches || []).filter((w) => w.name !== req.params.name); res.json({ ok: true }); });
app.delete("/api/sessions/:id/crons/:name", (req, res) => { const s = sessions.find((x) => x.id === req.params.id); s.crons = (s.crons || []).filter((c) => c.name !== req.params.name); res.json({ ok: true }); });
app.delete("/api/sessions/:id/wakeup", (req, res) => { const s = sessions.find((x) => x.id === req.params.id); setTimeout(() => { s.wakeup = null; }, 2500); res.json({ ok: true }); });
app.delete("/api/sessions/:id/wakeups/:name", (req, res) => { const s = sessions.find((x) => x.id === req.params.id); setTimeout(() => { s.wakeup = null; s.wakeups = (s.wakeups || []).filter((w) => w.name !== req.params.name); }, 2500); res.json({ ok: true }); });
app.post("/api/sessions/:id/autopause", (req, res) => { const s = sessions.find((x) => x.id === req.params.id); setTimeout(() => { s.autoPause = req.body.enabled ? "on" : "off"; }, 3000); res.json({ ok: true }); });
// Jarvis's per-session lock: POST /api/_mock/busy {id, kind|null, hidden?} sets it; `hidden`
// keeps it out of api/state (a list older than the lock), so the refusal itself can be tested.
const hiddenBusy = new Map();
app.post("/api/_mock/busy", (req, res) => { const s = sessions.find((x) => x.id === req.body.id); if (!s) return res.status(404).json({ error: "no such session" }); const b = req.body.kind ? { kind: req.body.kind, since: Date.now() } : null; hiddenBusy.delete(s.id); delete s.busy; if (b) { if (req.body.hidden) hiddenBusy.set(s.id, b); else s.busy = b; } res.json({ ok: true }); });
const refuseBusy = (req, res) => { const s = sessions.find((x) => x.id === req.params.id), b = s && (s.busy || hiddenBusy.get(s.id)); if (!b) return false; res.status(409).json({ error: `the session is ${b.kind} — try again once that finishes`, busy: b }); return true; };
app.get("/api/devices", (req, res) => res.json({ devices: [] }));
app.post("/api/sessions/:id/relogin", (req, res) => { if (refuseBusy(req, res)) return; res.json({ ok: true, prompted: true, text: "continue", expiresAt: Date.now() + 8 * 3600000 }); });
app.post("/api/sessions/:id/stop", (req, res) => { if (refuseBusy(req, res)) return; const s = sessions.find((x) => x.id === req.params.id); setTimeout(() => { s.state = "stopped"; s.status = undefined; }, 3000); res.json({ ok: true }); });
// start / permission-mode answer 202 with a wake job (like the real jarvis) and the dashboard
// follows GET /api/sessions/:id/wake until it ends; m2 fails its start (exercises the error toast)
const wakeJobs = {};
function mockWake(id, kind, phases, finish) {
  const cur = wakeJobs[id]; if (cur && !cur.finishedAt) return cur;
  const job = wakeJobs[id] = { kind, phase: phases[0], startedAt: Date.now(), finishedAt: null, error: null, needLogin: false };
  let t = 0; for (const ph of phases.slice(1)) setTimeout(() => { job.phase = ph; }, (t += 1500));
  setTimeout(() => { const r = finish(); Object.assign(job, r ? { phase: "failed", finishedAt: Date.now(), error: r } : { phase: "done", finishedAt: Date.now() }); }, t + 1500);
  return job;
}
// a Start / Restore prompt sits in the session (resumePrompt) until it has been typed in; a failed start takes it back
app.post("/api/sessions/:id/start", (req, res) => { const s = sessions.find((x) => x.id === req.params.id);
  if (req.body && req.body.prompt) { s.resumePrompt = String(req.body.prompt); console.log("start prompt", JSON.stringify(s.resumePrompt)); }
  const job = mockWake(s.id, "start", ["preparing", "starting"], () => { if (s.id === "m2") { s.resumePrompt = ""; return "start still refused after the config update (mock)"; } s.state = "started"; setTimeout(() => { s.status = "idle"; s.resumePrompt = ""; }, 3000); });
  res.status(202).json({ started: true, ...job }); });
app.post("/api/sessions/:id/permission-mode", (req, res) => { const s = sessions.find((x) => x.id === req.params.id); const mode = req.body.mode === "bypass" ? "bypass" : "auto";
  const job = mockWake(s.id, "permission-mode", ["preparing", "snapshotting", "starting"], () => { s.state = "started"; s.permissionMode = mode; setTimeout(() => { s.status = "idle"; }, 3000); });
  setTimeout(() => { s.state = "stopped"; s.status = undefined; }, 1500);
  res.status(202).json({ started: true, ...job }); });
app.get("/api/sessions/:id/wake", (req, res) => res.json(wakeJobs[req.params.id] || { phase: "none" }));
const destroyJobs = {};
app.delete("/api/sessions/:id", (req, res) => { const id = req.params.id, force = req.query.force === "1"; const cur = destroyJobs[id]; if (cur && !cur.finishedAt) return res.status(202).json({ started: true, ...cur });
  const job = destroyJobs[id] = { phase: "archiving", force, startedAt: Date.now(), finishedAt: null, error: null, archiveFailed: false, archived: null };
  // m2 fails its archive unless forced (exercises the "Destroy anyway?" path)
  setTimeout(() => { if (id === "m2" && !force) { Object.assign(job, { phase: "failed", finishedAt: Date.now(), error: "snapshot to Storage Box failed (mock)", archiveFailed: true }); return; }
    job.phase = "destroying"; setTimeout(() => { Object.assign(job, { phase: "done", finishedAt: Date.now(), archived: { dir: "claude-records/mock", files: 3 } }); const i = sessions.findIndex((x) => x.id === id); if (i >= 0) sessions.splice(i, 1); }, 2000); }, 3000);
  res.status(202).json({ started: true, ...job }); });
app.get("/api/sessions/:id/destroy", (req, res) => res.json(destroyJobs[req.params.id] || { phase: "none" }));
app.get("/api/sessions/:id/changes", (req, res) => res.json({ checked: true, repos: [{ name: "claude-env", uncommitted: 2, unpushed: 0 }], status: "idle" }));
// First-prompt attachments: drain the body slowly-ish (so the form's per-file progress is visible)
// and answer like lib/uploads.stage. The last create's attachments are at GET /api/_mock/last-attachments.
app.post("/api/uploads", (req, res) => { let size = 0; req.on("data", (c) => { size += c.length; req.pause(); setTimeout(() => req.resume(), 40); }); req.on("end", () => { const name = decodeURIComponent(req.get("x-upload-name") || "file"); res.json({ name, size, isImage: /\.(png|jpe?g|gif|webp)$/i.test(name) }); }); });
let lastAttachments = null;
app.get("/api/_mock/last-attachments", (req, res) => res.json(lastAttachments));
app.post("/api/sessions", (req, res) => { createCalls++; lastAttachments = req.body.attachments || null; const rid = req.body.requestId; if (rid && createdBy.has(rid)) { if (dropNextCreate > 0) { dropNextCreate--; return res.status(503).type("text/plain").send("tunnel agent is not connected (container offline or agent not running)"); } const d = createdBy.get(rid); return res.json({ ok: true, id: d.id, name: d.name, state: d.state, duplicate: true }); } if (req.body.oneShot && !req.body.prompt) return res.status(400).json({ error: "a one-shot session needs a prompt" }); const id = "m" + (sessions.length + 1); sessions.push({ id, name: req.body.label || "new", state: "created", region: "arn", created: new Date().toISOString(), ...req.body, environment: (req.body.environments || (req.body.environment ? [req.body.environment] : [])).join(","), repos: (req.body.repos || []).join(" "), autoPause: req.body.autoPause === false || req.body.oneShot ? "off" : "on", oneShot: !!req.body.oneShot }); setTimeout(() => { const s = sessions.find((x) => x.id === id); s.state = "started"; s.status = "idle"; }, 4000); const made = sessions.find((x) => x.id === id); delete made.requestId; if (rid) { made.createRequestId = rid; createdBy.set(rid, made); } if (dropNextCreate > 0) { dropNextCreate--; return setTimeout(() => req.socket.destroy(), 1500); } res.json({ ok: true, id }); });
// previous (destroyed) sessions: p1 restores into a new session, p2 fails its restore
const records = [
  { id: "p1", title: "Fix Jarvis sheet physics", machineName: "s-claude-env-k3j2a", environment: "default", repos: "https://github.com/DE0CH/claude-env.git", permissionMode: "auto", model: "claude-fable-5-1", size: "large", autoPause: "on", oneShot: false, created: new Date(now - 3 * 86400000).toISOString(), destroyedAt: new Date(now - 2 * 86400000).toISOString(), archiveDir: "claude-records/2026-09-14 Fix Jarvis sheet physics", transcripts: 2, artifacts: 14, last: { role: "assistant", text: "Pushed. The dismiss now accelerates off screen from the release velocity in under 280 ms; all three viewports pass the dashboard test.", at: new Date(now - 2 * 86400000 - 60000).toISOString() }, restored: [] },
  { id: "p2", title: "Paused research on Cathay fares with a fairly long title to wrap", machineName: "s-session-9d8f7", environment: "default", repos: "https://github.com/DE0CH/claude-env.git https://github.com/DE0CH/wda-build.git", permissionMode: "bypass", model: "claude-opus-5-5", size: "medium", autoPause: "on", oneShot: false, fromPauseSnapshot: true, created: new Date(now - 9 * 86400000).toISOString(), destroyedAt: new Date(now - 8 * 86400000).toISOString(), archiveDir: "claude-records/2026-09-08 Paused research", transcripts: 1, artifacts: null, last: { role: "user", text: "ok pause here, I'll come back to this once the December fares open", at: new Date(now - 8 * 86400000 - 3600000).toISOString() }, restored: [{ sessionId: "gone", at: new Date(now - 5 * 86400000).toISOString() }] },
  { id: "p3", title: "Weekly report", machineName: "s-weekly-report-1a2b3", environment: "scratch", repos: "", permissionMode: "auto", model: "claude-opus-5-5", size: "small", autoPause: "off", oneShot: true, created: new Date(now - 20 * 86400000).toISOString(), destroyedAt: new Date(now - 20 * 86400000).toISOString(), archiveDir: "claude-records/2026-08-28 Weekly report", transcripts: 1, artifacts: 0, restored: [] },
];
const restoreJobs = {};
// Transcript search: canned hits — or the real thing when MOCK_SEARCH_URL points at a running
// search service (node search/server.js with LOCAL_ROOT=<mirror>), for eyeballing real results.
const searchHit = (id, kind, title, snippet, extra) => ({ id, score: 0.9 - id / 100, via: ["keyword", "semantic"], kind, date: "2026-09-17", ts: null, title, sid: "sid-" + title.length, dir: "claude-records/2026-09-17 " + title, state: "archive", machineId: null, file: "f", lines: [1, 9], snippet, ...extra });
const cannedHits = [
  searchHit(1, "msg", "Subscribe to the economist", "[Claude] The payment was rejected by reCAPTCHA (PREPAY_RECAPTCHA_FAILED) — an anti-bot score gate, so no charge was made.", { dir: "claude-records/2026-09-14 Fix Jarvis sheet physics" }),
  searchHit(2, "tool", "Subscribe to the economist", "[Bash] # Warm the browser up before paying\n$ node warmup.js --dwell 30 && node pay.js a_very_long_unbroken_token_" + "x".repeat(60)),
  searchHit(3, "doc", "Long-running paused session with a rather long title", "[record.md] What failed vs what worked (reCAPTCHA Enterprise wall)", { state: "paused", machineId: "m2", dir: null }),
];
async function searchRelay(req, res, p) {
  const qs = new URLSearchParams(req.query).toString();
  try { const r = await fetch(process.env.MOCK_SEARCH_URL + p + (qs ? "?" + qs : "")); res.status(r.status).json(await r.json()); } catch (e) { res.status(502).json({ error: e.message }); }
}
app.get("/api/search", (req, res) => {
  if (process.env.MOCK_SEARCH_URL) return searchRelay(req, res, "/search");
  const q = String(req.query.q || ""), hits = cannedHits.filter((h) => (!req.query.kind || String(req.query.kind).split(",").includes(h.kind)) && (!req.query.state || String(req.query.state).split(",").includes(h.state)) && (req.query.archived !== "1" || h.dir)), none = /nothing/i.test(q);
  const base = { query: q, mode: "hybrid", reranked: true, total: none ? 0 : 42, tookMs: 640, timing: {}, notes: [], terms: q.split(/\s+/).filter(Boolean) };
  if (none) return res.json({ ...base, hits: [], sessions: [] });
  if (req.query.group === "1") { const by = new Map(); for (const h of hits) { const g = by.get(h.title) || { title: h.title, sid: h.sid, dir: h.dir, state: h.state, machineId: h.machineId, date: h.date, count: 0, hits: [] }; g.count += 3; g.hits.push(h); by.set(h.title, g); } return res.json({ ...base, sessions: [...by.values()] }); }
  res.json({ ...base, hits });
});
app.get("/api/search/context", (req, res) => {
  if (process.env.MOCK_SEARCH_URL) return searchRelay(req, res, "/context");
  const h = cannedHits.find((x) => x.id === Number(req.query.id)); if (!h) return res.status(404).json({ error: "no such chunk" });
  const n = (k) => Math.min(Number(req.query[k]) || 3, 30), mk = (id, kind, text, hit) => ({ id, kind, ts: null, lineFrom: id, lineTo: id, text, hit });
  res.json({ session: { title: h.title, dir: h.dir }, file: h.file, chunks: [
    ...[...Array(n("before")).keys()].map((i) => mk(100 + i, i % 2 ? "tool" : "msg", i % 2 ? "[Bash] # step\n$ curl https://example.com/" + i + "\n\n[→ Bash] HTTP 200" : "[Deyao] Earlier question " + i + "?\n\n[Claude] Earlier answer " + i + ".")),
    mk(h.id, h.kind, h.snippet, true),
    ...[...Array(n("after")).keys()].map((i) => mk(200 + i, "msg", "[Claude] Later message " + i + ".")),
  ] });
});
app.get("/api/search/status", (req, res) => res.json({ ok: true, chunks: 15479, sessions: 186, vectors: 15415, indexer: { state: "idle" } }));
app.get("/api/records", (req, res) => res.json({ records: records.map((r) => (restoreJobs[r.id] ? { ...r, restore: { phase: restoreJobs[r.id].phase, error: restoreJobs[r.id].error } } : r)) }));
app.get("/api/records/:id/tail", (req, res) => { const r = records.find((x) => x.id === req.params.id); const t = (m) => new Date(Date.parse(r.destroyedAt) - m * 60000).toISOString();
  res.json({ title: r.title, messages: [...Array(6).keys()].flatMap((i) => [{ role: "user", text: `Question ${i + 1} about ${r.title.toLowerCase()}?`, at: t(60 - i * 8) }, { role: "assistant", text: `Answer ${i + 1}.\n\nA second paragraph with a_very_long_unbroken_token_${"x".repeat(60)} to check wrapping on a phone.`, at: t(58 - i * 8) }]).concat(r.last ? [r.last] : []) }); });
app.post("/api/records/:id/restore", (req, res) => { const r = records.find((x) => x.id === req.params.id); const cur = restoreJobs[r.id]; if (cur && !cur.finishedAt) return res.status(202).json({ started: true, ...cur });
  const prompt = String((req.body && req.body.prompt) || ""); if (prompt) console.log("restore prompt", JSON.stringify(prompt));
  const job = restoreJobs[r.id] = { phase: "preparing", startedAt: Date.now(), finishedAt: null, error: null, result: null };
  ["creating", "seeding", "starting"].forEach((ph, i) => setTimeout(() => { job.phase = ph; }, (i + 1) * 800));
  setTimeout(() => { if (r.id === "p2") return Object.assign(job, { phase: "failed", finishedAt: Date.now(), error: "restore manifest missing (mock)" });
    const id = "m" + Date.now().toString(36); sessions.unshift({ id, name: "s-restored", state: "started", region: "arn", created: new Date().toISOString(), environment: r.environment, repos: r.repos, permissionMode: r.permissionMode, model: r.model, autoPause: r.autoPause, guest: "8×shared · 8 GB", label: r.title, resumePrompt: prompt });
    setTimeout(() => { const n = sessions.find((x) => x.id === id); n.status = "idle"; setTimeout(() => { n.resumePrompt = ""; }, 3000); }, 2000);
    r.restored.push({ sessionId: id, at: new Date().toISOString() }); Object.assign(job, { phase: "done", finishedAt: Date.now(), result: { sessionId: id, transcripts: r.transcripts, artifacts: r.artifacts } }); }, 3200);
  res.status(202).json({ started: true, ...job }); });
app.get("/api/records/:id/restore", (req, res) => res.json(restoreJobs[req.params.id] || { phase: "none" }));
app.delete("/api/records/:id", (req, res) => { const i = records.findIndex((x) => x.id === req.params.id); if (i < 0) return res.status(404).json({ error: "no such previous session in the index" });
  const [r] = records.splice(i, 1); res.json({ ok: true, ...(req.query.purge === "1" ? { purged: { dir: r.archiveDir, removed: "folder" }, reindex: "started" } : {}) }); });
// the test runs three viewports against this one process: each run starts from the same canned
// state (sessions created / restored / destroyed by the previous run are forgotten)
const initial = JSON.stringify({ sessions, records });
// an OpenCode-harness session, added on demand (the canned list stays two cards: the overflow checks assume a short list)
app.post("/api/mock/opencode", (req, res) => { if (!sessions.some((x) => x.id === "oc1")) sessions.push({ id: "oc1", name: "s-opencode-cd34e", state: "started", status: "idle", region: "lhr", created: new Date(now - 26 * 3600000).toISOString(), environment: "default", repos: "https://github.com/DE0CH/claude-env.git", permissionMode: "bypass", model: "openrouter/z-ai/glm-5.3", harness: "opencode", autoPause: "on", guest: "4×shared · 4 GB", label: "OpenCode session", aiTitle: "" }); res.json({ ok: true }); });
app.post("/api/mock/openclaw", (req, res) => { if (!sessions.some((x) => x.id === "ocl1")) sessions.push({ id: "ocl1", name: "s-openclaw-ef56a", state: "started", status: "idle", region: "lhr", created: new Date(now - 3 * 3600000).toISOString(), environment: "default", repos: "https://github.com/DE0CH/claude-env.git", permissionMode: "bypass", model: "openclaw/claude-opus-5-5", harness: "openclaw", autoPause: "on", guest: "4×shared · 4 GB", label: "OpenClaw session", aiTitle: "" }); res.json({ ok: true }); });
app.post("/api/mock/paused-remote", (req, res) => { const h = req.body && req.body.harness === "opencode" ? "opencode" : "openclaw"; const id = h === "opencode" ? "ocp1" : "oclp1";
  if (!sessions.some((x) => x.id === id)) sessions.push({ id, name: "s-" + h + "-paused", state: "stopped", status: "", region: "lhr", created: new Date(now - 48 * 3600000).toISOString(), environment: "default", repos: "https://github.com/DE0CH/claude-env.git", permissionMode: "bypass", model: h === "opencode" ? "openrouter/z-ai/glm-5.3" : "openclaw/claude-fable-5-1", harness: h, autoPause: "on", guest: "4×shared · 4 GB", label: "Paused " + h + " session", aiTitle: "" }); res.json({ ok: true }); });
app.post("/api/mock/reset", (req, res) => { const i = JSON.parse(initial); sessions.splice(0, sessions.length, ...i.sessions); records.splice(0, records.length, ...i.records);
  for (const o of [wakeJobs, destroyJobs, restoreJobs]) for (const k of Object.keys(o)) delete o[k]; res.json({ ok: true }); });
app.post("/api/auth/start", (req, res) => res.json({ url: "https://claude.ai/oauth/authorize?mock=1" }));
app.post("/api/environments", (req, res) => { console.log("env save", Object.keys(req.body.secrets || {})); res.json({ ok: true }); });
app.post("/api/repos", (req, res) => res.json({ ok: true }));
// Tasks: the real lib/tasks.js over an in-memory cluster + the repo's own selfhost/tasks templates.
// A run starts → runs (after 1.5 s) → succeeds (after 5 s; a prompt containing "fail" fails).
{
  const fs = require("fs");
  const REPO = __dirname;
  const cms = new Map(), jobs = new Map(); let uid = 0;
  const tick = (j) => {
    const age = Date.now() - j._at, p = JSON.parse((j.spec.template.spec.containers[0].env.find((e) => e.name === "TASK_PARAMS") || {}).value || "{}");
    if (j.spec.suspend || j.status.succeeded || j.status.failed) return;
    if (age > 5000) { const bad = /fail/.test(JSON.stringify(p)); j.status = bad ? { failed: 1, startTime: new Date(j._at).toISOString(), conditions: [{ type: "Failed", status: "True", reason: "BackoffLimitExceeded", message: "Job has reached the specified backoff limit", lastTransitionTime: new Date().toISOString() }] } : { succeeded: 1, startTime: new Date(j._at).toISOString(), completionTime: new Date().toISOString(), conditions: [{ type: "Complete", status: "True" }] }; j._exit = bad ? 1 : 0; }
    else if (age > 1500) j.status = { active: 1, ready: 1, startTime: new Date(j._at).toISOString() };
  };
  const k8sFake = {
    namespace: () => "claude",
    get: async (res, name) => (res === "configmaps" ? cms.get(name) || null : null),
    apply: async (m) => { cms.set(m.metadata.name, m); return m; },
    call: async (method, p, body, opts = {}) => {
      const [base, q = ""] = p.split("?"), qs = new URLSearchParams(q);
      const name = (base.match(/\/jobs\/([^/]+)$/) || [])[1];
      const match = (j) => { const s = qs.get("labelSelector"); if (!s) return true; const [k, v] = s.split("="); return k === "job-name" ? j.metadata.name === v : (j.metadata.labels || {})[k] === v; };
      for (const j of jobs.values()) tick(j);
      if (base.endsWith("/pods")) return { items: [...jobs.values()].filter(match).map((j) => ({ metadata: { name: j.metadata.name + "-x1", creationTimestamp: j.metadata.creationTimestamp }, status: { phase: j.status.active ? "Running" : "Pending", containerStatuses: j._exit != null ? [{ state: { terminated: { exitCode: j._exit } } }] : [] } })) };
      if (base.endsWith("/log")) { const j = jobs.get(base.split("/").slice(-2)[0].replace(/-x1$/, "")); return j && j.status.active || j && j._exit != null ? `run ${j.metadata.name}\nTASK_PARAMS=${(j.spec.template.spec.containers[0].env.find((e) => e.name === "TASK_PARAMS") || {}).value}\n` + (j._exit === 1 ? "Traceback (most recent call last):\nSystemExit: Jarvis answered HTTP 400\n" : j._exit === 0 ? "started session 4d89abc ( s-daily-digest ) · claude-opus-5-5 · medium · interactive\n" : "") : ""; }
      if (method === "POST") { if (jobs.has(body.metadata.name)) throw Object.assign(new Error("exists"), { status: 409 }); const j = { ...body, _at: Date.now(), metadata: { ...body.metadata, uid: String(++uid), creationTimestamp: new Date().toISOString() }, status: {} }; jobs.set(j.metadata.name, j); return j; }
      if (method === "GET" && !name) return { items: [...jobs.values()].filter(match) };
      if (method === "GET") return jobs.get(name) || (opts.allow404 ? null : Promise.reject(Object.assign(new Error("not found"), { status: 404 })));
      if (method === "DELETE") { if (name) jobs.delete(name); else for (const [k, j] of jobs) if (match(j)) jobs.delete(k); return {}; }
      if (method === "PATCH") { const j = jobs.get(name); if (body.spec) Object.assign(j.spec, body.spec); if (body.metadata) Object.assign(j.metadata.annotations, body.metadata.annotations); return j; }
      return {};
    },
  };
  const gitFake = { read: async (fn) => fn(REPO), transaction: async (m, fn) => fn(fs.mkdtempSync("/tmp/mock-tasks-")), writeYamlish: () => {} };
  const storeFake = { get: async () => ({ taskImage: "ghcr.io/de0ch/jarvis-tasks:sha-mock", environments: { default: { secrets: { A: "1", B: "2" } }, scratch: { secrets: { FOO: "x" } } }, repos: [{ name: "claude-env", url: "https://github.com/DE0CH/claude-env.git" }, { name: "wda-build", url: "https://github.com/DE0CH/wda-build.git" }] }) };
  const options = async () => ({
    environments: [{ value: "default", label: "default", sub: "2 keys" }, { value: "scratch", label: "scratch", sub: "1 keys" }],
    repos: [{ value: "claude-env", label: "claude-env", sub: "https://github.com/DE0CH/claude-env.git" }, { value: "wda-build", label: "wda-build", sub: "https://github.com/DE0CH/wda-build.git" }],
    models: [{ value: "claude-opus-5-5", label: "Opus 5.5 · Claude Code", sub: "claude-opus-5-5" }, { value: "claude-fable-5-1", label: "Fable 5.1 · Claude Code", sub: "claude-fable-5-1" }],
    sizes: [{ value: "small", label: "Small", sub: "2 shared vCPU · 2 GB" }, { value: "medium", label: "Medium", sub: "4 shared vCPU · 4 GB" }],
    content: [{ value: "notes", label: "notes", sub: "3 files" }],
  });
  const T = require("./lib/tasks").create({ k8s: k8sFake, git: gitFake, store: storeFake, options });
  const h = (fn) => (req, res) => Promise.resolve(fn(req)).then((x) => res.json(x), (e) => res.status(e.status || 500).json({ error: e.message }));
  // one instance + a daily schedule to start from
  T.saveInstance(null, { template: "new-session", name: "Daily price digest", params: { prompt: "Post the daily hotel price digest to Discord", title: "Daily price digest", mode: "oneshot" } })
    .then((i) => T.saveSchedule(null, { instance: i.id, time: "08:30", tz: "Europe/London" })).catch((e) => console.error("[mock tasks]", e.message));
  app.get("/api/tasks", h((req) => T.overview()));
  app.post("/api/tasks/instances", h((req) => T.saveInstance(null, req.body)));
  app.put("/api/tasks/instances/:id", h((req) => T.saveInstance(req.params.id, req.body)));
  app.delete("/api/tasks/instances/:id", h(async (req) => { await T.deleteInstance(req.params.id); return { ok: true }; }));
  app.post("/api/tasks/instances/:id/run", h((req) => T.startRun(req.params.id)));
  app.get("/api/tasks/instances/:id/runs", h(async (req) => ({ runs: await T.runs(req.params.id) })));
  app.get("/api/tasks/runs/:name", h((req) => T.runDetail(req.params.name)));
  app.post("/api/tasks/runs/:name/stop", h(async (req) => { await T.stopRun(req.params.name); return { ok: true }; }));
  app.post("/api/tasks/schedules", h((req) => T.saveSchedule(null, req.body)));
  app.put("/api/tasks/schedules/:id", h((req) => T.saveSchedule(req.params.id, req.body)));
  app.delete("/api/tasks/schedules/:id", h(async (req) => { await T.deleteSchedule(req.params.id); return { ok: true }; }));
}
app.use((req, res, next) => { if (req.path.startsWith("/api/")) return res.status(404).json({ error: "mock: no route " + req.method + " " + req.path }); next(); });
// Test hook: the next New session create happens but its connection is killed before the reply
// (?n=3: the first reply is lost, the next retries get the tunnel's plain-text 503 — as during a
// Jarvis rollout; Chromium itself re-sends a POST on a reset, so later drops must be a real reply)
// (a reply lost in the tunnel); /__mock/creates counts create calls and sessions made per requestId.
app.get("/__mock/drop-next-create", (req, res) => { dropNextCreate = Number(req.query.n || 1); res.json({ ok: true }); });
app.get("/__mock/creates", (req, res) => res.json({ calls: createCalls, sessions: [...createdBy.values()] }));
core.routes(app, { sessions });
const port = +process.argv[2] || +process.env.PORT || 18080, host = process.env.HOST || "127.0.0.1";
app.listen(port, host, () => console.log(`mock jarvis 2 on http://${host}:${port}/`));
