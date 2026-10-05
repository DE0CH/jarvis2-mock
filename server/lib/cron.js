// Recurring wakeups ("crons"): at a fixed period (daily by default) Jarvis delivers a PROMPT
// into the session (lib/peer.js — starting the machine first if it is paused), so Claude itself
// does the recurring job with its full toolset and judgement: a model turn, not a check script
// (that is a watch, lib/watch.js) and not a one-shot (the timed wakeup). Several named crons per
// session, independent of its one-shot wakeup and its watches; arming an existing name replaces it.
//
// Schedule: `nextAt` (ms epoch) is the next firing; after each delivery it advances by whole
// periods past now, so a session that was unreachable for a while fires once, not a backlog.
// First firing: `at` (ISO / ms epoch), `delaySeconds`, or `time` "HH:MM" (UTC, next occurrence;
// with `tz` an IANA zone such as "Asia/Shanghai", evaluated in that zone). Optional `until` (ISO)
// ends the cron after its last firing before that moment.
//
// Storage: one Fly machine metadata key per cron, `cron_<name>` = JSON, so it survives jarvis
// rollouts and pauses (the paused record carries the metadata) like a wakeup does.
const NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const KEY_PREFIX = "cron_";
const MAX_PROMPT = 3500; // metadata value budget (a wakeup prompt of 4000 is known to fit, plus the JSON around it)
const MIN_EVERY = 15 * 60, DEFAULT_EVERY = 24 * 60 * 60, MAX_EVERY = 90 * 24 * 60 * 60;
const MAX_UNTIL_MS = 400 * 24 * 60 * 60 * 1000;

function keyFor(name) { return KEY_PREFIX + name; }

// Offset (ms) of `tz` from UTC at instant t: the wall clock there minus UTC.
function tzOffsetMs(tz, t) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - Math.floor(t / 1000) * 1000;
}
// The next instant after `now` whose wall-clock time in `tz` is hh:mm.
function nextTimeOfDay(hh, mm, tz, now) {
  for (let d = -1; d <= 2; d++) {
    const day = new Date(now + d * 86400000);
    const off = tzOffsetMs(tz, now + d * 86400000);
    const local = new Date(day.getTime() + off); // wall-clock date in tz (read with UTC getters)
    const t = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hh, mm) - off;
    if (t > now) return t;
  }
  throw new Error("could not compute the next time of day");
}

// Validate + normalize a request body into the stored shape. Throws Error(message) on bad input.
function normalize(body, now = Date.now()) {
  const b = body || {};
  const name = String(b.name || "").trim();
  if (!NAME_RE.test(name)) throw new Error("name must be 1-40 chars of letters, digits, _ or -");
  const prompt = String(b.prompt || "").replace(/\s+/g, " ").trim();
  if (!prompt) throw new Error("prompt is required — what the session should do each time");
  if (prompt.length > MAX_PROMPT) throw new Error(`prompt longer than ${MAX_PROMPT} characters`);
  const every = b.everySeconds == null ? DEFAULT_EVERY : Math.round(Number(b.everySeconds));
  if (!Number.isFinite(every) || every < MIN_EVERY || every > MAX_EVERY) throw new Error(`everySeconds must be ${MIN_EVERY}–${MAX_EVERY}`);
  const tz = String(b.tz || "UTC");
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { throw new Error(`unknown time zone ${JSON.stringify(tz)}`); }
  let nextAt;
  if (b.time != null) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(b.time).trim());
    if (!m || +m[1] > 23 || +m[2] > 59) throw new Error("time must be HH:MM");
    nextAt = nextTimeOfDay(+m[1], +m[2], tz, now);
  } else if (b.delaySeconds != null) {
    const d = Number(b.delaySeconds); if (!Number.isFinite(d) || d <= 0) throw new Error("delaySeconds must be a positive number");
    nextAt = now + d * 1000;
  } else if (b.at != null) {
    nextAt = typeof b.at === "number" ? b.at : Date.parse(String(b.at));
    if (!Number.isFinite(nextAt)) throw new Error("at must be an ISO-8601 time or ms epoch");
    if (nextAt <= now) throw new Error("the first firing is in the past");
  } else nextAt = now + every * 1000;
  let until = null;
  if (b.until != null && b.until !== "") {
    until = typeof b.until === "number" ? b.until : Date.parse(String(b.until));
    if (!Number.isFinite(until) || until <= nextAt) throw new Error("until must be a time after the first firing");
    if (until - now > MAX_UNTIL_MS) throw new Error("until is more than 400 days away");
  }
  return { name, prompt, every, tz, nextAt: Math.round(nextAt), until, armedAt: now, runs: 0, lastFiredAt: null };
}

// After a firing (or a skipped one): the next occurrence strictly after now, or null when past `until`.
function advance(c, now = Date.now()) {
  let next = c.nextAt;
  if (next <= now) next += Math.ceil((now - next + 1) / (c.every * 1000)) * c.every * 1000;
  if (c.until && next > c.until) return null;
  return next;
}

function serialize(c) { return JSON.stringify(c); }
function parse(value) {
  try { const c = JSON.parse(value); return c && NAME_RE.test(c.name || "") && c.prompt && c.every > 0 && Number.isFinite(c.nextAt) ? c : null; } catch { return null; }
}
// All crons stored on a machine (from its metadata), soonest first.
function cronsOf(m) {
  const md = m.config?.metadata || {};
  const out = [];
  for (const [k, v] of Object.entries(md)) {
    if (!k.startsWith(KEY_PREFIX)) continue;
    const c = parse(v);
    if (c) out.push(c);
  }
  return out.sort((a, b) => a.nextAt - b.nextAt);
}
function view(c) {
  return { name: c.name, prompt: c.prompt, everySeconds: c.every, tz: c.tz || "UTC", nextAt: c.nextAt, nextAtIso: new Date(c.nextAt).toISOString(),
    until: c.until || null, untilIso: c.until ? new Date(c.until).toISOString() : null, armedAtIso: new Date(c.armedAt).toISOString(),
    runs: c.runs || 0, lastFiredIso: c.lastFiredAt ? new Date(c.lastFiredAt).toISOString() : null };
}

module.exports = { normalize, advance, serialize, parse, keyFor, cronsOf, view, nextTimeOfDay, NAME_RE, KEY_PREFIX };
