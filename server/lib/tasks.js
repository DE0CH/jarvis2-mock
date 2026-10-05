// Tasks: script TEMPLATES instantiated with data into INSTANCES, run on a click or on a daily
// SCHEDULE as one-off Kubernetes Jobs. A structure of their own: unlike wakeups/crons/watches they
// belong to no session (Deyao, 2026-10-01).
//
//   template  selfhost/tasks/<name>/task.json + its files, written by Claude, read from Jarvis's git
//             clone. task.json: { title, description?, run ("run.py"), stores? ["default"], image?,
//             timeoutSeconds? (600), memory? ("512Mi"), fields: [{ name, label?, type
//             (text|textarea|number|select|multiselect|checkbox), required?, default?, options?,
//             optionsFrom?, help?, placeholder? }] }
//             A (multi)select lists `options` (["a", {value, label}]) or takes them live from Jarvis
//             with `optionsFrom`: environments (secret stores) | repos | models | sizes | content (content stores) — the same
//             lists the New session page offers.
//             A select with `optionsFrom: "environments"` may name `secretKeys` (["AES_KEY"]): the run
//             gets just those keys from the secret store picked in that field (env secretKeyRef), and
//             is refused when the picked store lacks one.
//   instance  { id, template, name, params, hidden?, createdAt } — a template + filled-in field values.
//             `hidden` = field names whose value is NEVER echoed back (Deyao, 2026-10-02): the API and the
//             app see only that the field is hidden (+ whether it has a value), run logs served by the
//             API have the value replaced by [hidden]. One-way: a hidden value can be replaced or
//             cleared, never shown. The values live NOT in jarvis-tasks.yaml (which every session has in its
//             checkout) but in a sops-encrypted Secret task-hidden-<id> (keys: the field names + TASK_PARAMS,
//             the full JSON); a run gets them by secretKeyRef. Friction against a session stumbling on them,
//             not a vault: Jarvis itself reads them (merge on edit, log redaction).
//   schedule  { id, instance, time "HH:MM", tz, enabled, since } — run the instance daily at time in tz
//   run       a k8s Job in Jarvis's namespace (labelled with its instance); the Jobs ARE the run
//             history (newest KEEP_RUNS per instance kept, plus ttlSecondsAfterFinished)
//
// Instances + schedules are git-backed like the env stores: selfhost/k8s/config/jarvis-tasks.yaml
// (ConfigMap jarvis-tasks), written through a git transaction then applied.
//
// A run's pod: the task image (jarvis-config taskImage, built from selfhost/task-image) or the
// template's own `image`; the template's files mounted read-only at /task; cwd + HOME an empty
// /work; env = the declared stores' Secrets (envFrom env-<store>) then PARAM_<FIELD> for each field
// plus TASK_PARAMS (all values as JSON), TASK_INSTANCE, TASK_NAME, TASK_RUN, TASK_TRIGGER. No
// ServiceAccount token, non-root, no privilege escalation.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { nextTimeOfDay } = require("./cron");

const TEMPLATES_DIR = "selfhost/tasks";
const TASKS_CM = "jarvis-tasks";
const TASKS_PATH = "selfhost/k8s/config/jarvis-tasks.yaml";
const KEEP_RUNS = 20;
const RUN_TTL_SECONDS = 30 * 86400;
const SCHEDULE_GRACE_MS = 2 * 3600 * 1000; // a slot missed by more than this (Jarvis down) is skipped
const MAX_FILES_BYTES = 512 * 1024;
const L = { run: "selfhost.claude/task-run", instance: "selfhost.claude/task-instance", template: "selfhost.claude/task-template", trigger: "selfhost.claude/task-trigger" };
const A = { name: "selfhost.claude/task-name", schedule: "selfhost.claude/task-schedule", slot: "selfhost.claude/task-slot", notified: "selfhost.claude/task-notified" };

const TEMPLATE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const FIELD_RE = /^[a-z][a-z0-9_]{0,39}$/;
const ID_RE = /^[a-f0-9]{8}$/;
const TYPES = ["text", "textarea", "number", "select", "multiselect", "checkbox"];
const OPTION_SOURCES = ["environments", "repos", "models", "sizes", "content"];
const isSelect = (type) => type === "select" || type === "multiselect";
const newId = () => crypto.randomBytes(4).toString("hex");
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

// ---- templates ------------------------------------------------------------------------------
const option = (o) => (o && typeof o === "object" ? { value: String(o.value), label: String(o.label || o.value), ...(o.sub ? { sub: String(o.sub) } : {}) } : { value: String(o), label: String(o) });
// Fill the live option lists in (sources: { environments: [...], repos: [...], … } of options)
function resolveOptions(t, sources) {
  if (t.error || !t.fields.some((f) => f.optionsFrom)) return t;
  return { ...t, fields: t.fields.map((f) => (f.optionsFrom ? { ...f, options: ((sources || {})[f.optionsFrom] || []).map(option) } : f)) };
}

// Validate a task.json (+ the dir's file list) into the template shape. Throws on a bad spec.
function parseTemplate(name, spec, files) {
  if (!TEMPLATE_RE.test(name)) throw new Error(`template dir name "${name}" must be lowercase letters/digits/dashes`);
  const s = spec || {};
  const title = String(s.title || "").trim();
  if (!title) throw new Error("title is required");
  const run = String(s.run || ["run.py", "run.sh", "run.js"].find((f) => files.includes(f)) || "");
  if (!run || !files.includes(run)) throw new Error(`run file ${JSON.stringify(run || "run.py")} is not in the template dir`);
  const stores = Array.isArray(s.stores) ? s.stores.map(String) : [];
  for (const st of stores) if (!/^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$/.test(st)) throw new Error(`bad store name ${JSON.stringify(st)}`);
  const timeoutSeconds = s.timeoutSeconds == null ? 600 : Math.round(Number(s.timeoutSeconds));
  if (!(timeoutSeconds >= 10 && timeoutSeconds <= 6 * 3600)) throw new Error("timeoutSeconds must be 10–21600");
  const memory = String(s.memory || "512Mi");
  if (!/^\d{1,5}(Mi|Gi)$/.test(memory)) throw new Error("memory must look like 512Mi or 2Gi");
  const seen = new Set();
  const fields = (Array.isArray(s.fields) ? s.fields : []).map((f0) => {
    const f = f0 || {};
    const fname = String(f.name || "");
    if (!FIELD_RE.test(fname)) throw new Error(`field name ${JSON.stringify(fname)} must be lowercase letters/digits/_`);
    if (seen.has(fname)) throw new Error(`field ${fname} is defined twice`);
    seen.add(fname);
    const type = String(f.type || "text");
    if (!TYPES.includes(type)) throw new Error(`field ${fname}: type must be one of ${TYPES.join(", ")}`);
    const out = { name: fname, label: String(f.label || fname), type, required: !!f.required };
    if (f.help) out.help = String(f.help);
    if (f.placeholder) out.placeholder = String(f.placeholder);
    if (isSelect(type)) {
      if (f.optionsFrom != null) {
        if (!OPTION_SOURCES.includes(f.optionsFrom)) throw new Error(`field ${fname}: optionsFrom must be one of ${OPTION_SOURCES.join(", ")}`);
        out.optionsFrom = f.optionsFrom;
        out.options = [];
      } else {
        out.options = (Array.isArray(f.options) ? f.options : []).map(option);
        if (!out.options.length) throw new Error(`field ${fname}: a ${type} needs options or optionsFrom`);
      }
    }
    if (f.secretKeys != null) {
      if (type !== "select" || out.optionsFrom !== "environments") throw new Error(`field ${fname}: secretKeys needs a select with optionsFrom "environments"`);
      const keys = Array.isArray(f.secretKeys) ? f.secretKeys.map(String) : [];
      if (!keys.length || keys.some((k) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))) throw new Error(`field ${fname}: secretKeys must be a list of env var names`);
      out.secretKeys = keys;
    }
    if (f.default !== undefined) out.default = f.default;
    return out;
  });
  const out = { name, title, description: String(s.description || ""), run, stores, timeoutSeconds, memory, fields, files };
  if (s.image) out.image = String(s.image);
  return out;
}

// Read every template from the git clone (selfhost/tasks/*/task.json). A broken one is listed with
// its `error` instead of being dropped, so a typo shows on the page instead of a missing card.
function readTemplates(repoDir) {
  const root = path.join(repoDir, TEMPLATES_DIR);
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; }
  return dirs.map((name) => {
    const dir = path.join(root, name);
    try {
      const files = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile() && d.name !== "task.json").map((d) => d.name).sort();
      const spec = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
      const t = parseTemplate(name, spec, files);
      t.source = fs.readFileSync(path.join(dir, t.run), "utf8").slice(0, 100000);
      return t;
    } catch (e) { return { name, title: name, error: e.message, fields: [], files: [] }; }
  });
}
// The template's files as ConfigMap data (text) / binaryData (anything that isn't UTF-8).
function templateFiles(repoDir, t) {
  const data = {}, binaryData = {};
  let total = 0;
  for (const f of t.files) {
    const buf = fs.readFileSync(path.join(repoDir, TEMPLATES_DIR, t.name, f));
    total += buf.length;
    if (total > MAX_FILES_BYTES) throw bad(`template ${t.name}'s files are over ${MAX_FILES_BYTES / 1024} KB`);
    const s = buf.toString("utf8");
    if (Buffer.from(s, "utf8").equals(buf)) data[f] = s; else binaryData[f] = buf.toString("base64");
  }
  return { data, binaryData };
}

// Check + normalise an instance's values against the template's fields: unknown keys dropped,
// defaults filled in, types coerced (numbers as numbers, checkboxes as booleans, the rest strings).
function checkParams(t, params) {
  const p = params || {}, out = {};
  for (const f of t.fields) {
    let v = p[f.name];
    if (v === undefined || v === null || v === "") v = f.default;
    if (f.type === "checkbox") { out[f.name] = v === true || v === "true"; continue; }
    if (f.type === "multiselect") {
      const list = (Array.isArray(v) ? v : v == null || v === "" ? [] : String(v).split(",")).map((x) => String(x).trim()).filter(Boolean);
      for (const x of list) if (!f.options.some((o) => o.value === x)) throw bad(`“${f.label}”: ${JSON.stringify(x)} is not one of ${f.options.map((o) => o.value).join(", ")}`);
      if (f.required && !list.length) throw bad(`“${f.label}” needs at least one choice`);
      out[f.name] = [...new Set(list)];
      continue;
    }
    if (v === undefined || v === null || v === "") {
      if (f.required) throw bad(`“${f.label}” is required`);
      out[f.name] = f.type === "number" ? null : "";
      continue;
    }
    if (f.type === "number") {
      const n = Number(v);
      if (!Number.isFinite(n)) throw bad(`“${f.label}” must be a number`);
      out[f.name] = n;
    } else if (f.type === "select") {
      if (!f.options.some((o) => o.value === String(v))) throw bad(`“${f.label}” must be one of ${f.options.map((o) => o.value).join(", ")}`);
      out[f.name] = String(v);
    } else out[f.name] = String(v);
  }
  return out;
}

// What the API returns for an instance: `hidden` (field names) + `hiddenSet` (those with a value);
// the record never holds hidden values (they are in its task-hidden-<id> Secret).
function publicInstance(i) {
  if (!(i.hidden || []).length) return i;
  return { ...i, params: { ...i.params }, hidden: [...i.hidden], hiddenSet: [...(i.hiddenSet || [])] };
}
// The strings a run log must not show (each hidden value; list items one by one), longest first.
function hiddenStrings(values) {
  const out = [];
  for (const v of Object.values(values || {})) for (const x of Array.isArray(v) ? v : [v]) if (x != null && String(x).length >= 3) out.push(String(x));
  return out.sort((a, b) => b.length - a.length);
}
function redact(text, strings) {
  let t = String(text || "");
  for (const s of strings) t = t.split(s).join("[hidden]");
  return t;
}
const filled = (v) => v != null && v !== "" && v !== false && !(Array.isArray(v) && !v.length);
// Merge an edit: a hidden field the body does not mention keeps its old value (the client never had
// it); one it mentions is replaced ("" / null clears it). Returns the full checked params, the hidden
// field names, and the split: `visible` (stored in the record) / `secret` (stored in the Secret).
function mergeParams(t, cur, curHidden, body, hide) {
  const known = new Set(t.fields.map((f) => f.name));
  for (const f of hide) if (!known.has(f)) throw bad(`no field “${f}” to hide`);
  const hidden = [...new Set([...((cur && cur.hidden) || []), ...hide])].filter((f) => known.has(f));
  const given = (body && body.params) || {};
  const merged = { ...given };
  for (const f of hidden) {
    if (Object.prototype.hasOwnProperty.call(given, f)) continue;
    if (curHidden && f in curHidden) merged[f] = curHidden[f];       // already hidden: from its Secret
    else if (cur && cur.params && f in cur.params) merged[f] = cur.params[f]; // being hidden now
  }
  const params = checkParams(t, merged), visible = {}, secret = {};
  for (const [k, v] of Object.entries(params)) (hidden.includes(k) ? secret : visible)[k] = v;
  return { params, hidden, visible, secret, hiddenSet: hidden.filter((f) => filled(params[f])) };
}

// ---- schedules ------------------------------------------------------------------------------
function parseTime(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time || "").trim());
  if (!m || +m[1] > 23 || +m[2] > 59) throw bad("time must be HH:MM (24-hour)");
  return [+m[1], +m[2]];
}
function checkTz(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { throw bad(`unknown time zone ${JSON.stringify(tz)}`); }
  return tz;
}
const fmtTime = ([h, m]) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
// The next daily slot after `now`.
function nextSlot(s, now = Date.now()) { const [h, m] = parseTime(s.time); return nextTimeOfDay(h, m, s.tz, now); }
// The latest daily slot at or before `now` (null if none in the last ~26 h, which cannot happen).
function lastSlot(s, now = Date.now()) {
  const [h, m] = parseTime(s.time);
  let t = nextTimeOfDay(h, m, s.tz, now - 26 * 3600 * 1000);
  if (t > now) return null;
  for (;;) { const n = nextTimeOfDay(h, m, s.tz, t); if (n > now) return t; t = n; }
}
// The slot a schedule should fire for at `now`, or null: the latest slot, if it is after the
// schedule was made/changed (`since`) and not missed by more than the grace period.
function dueSlot(s, now = Date.now()) {
  if (!s.enabled) return null;
  const t = lastSlot(s, now);
  if (t == null || t < (s.since || 0) || now - t > SCHEDULE_GRACE_MS) return null;
  return t;
}

// ---- runs (k8s Jobs) ------------------------------------------------------------------------
const runName = (instanceId, { scheduleId, slot, now = Date.now() } = {}) =>
  scheduleId ? `task-${instanceId}-${scheduleId}-${Math.floor(slot / 60000).toString(36)}` : `task-${instanceId}-${now.toString(36)}`;
function command(run) {
  if (/\.py$/.test(run)) return ["python3", "-u", "/task/" + run];
  if (/\.sh$/.test(run)) return ["bash", "/task/" + run];
  if (/\.(m?js|cjs)$/.test(run)) return ["node", "/task/" + run];
  return ["/task/" + run];
}
const envName = (f) => "PARAM_" + f.toUpperCase();
// The `secretKeys` a run gets from the stores picked in its fields: [{store, key}]
const pickedKeys = (t, params) => t.fields.filter((f) => f.secretKeys && params[f.name]).flatMap((f) => f.secretKeys.map((key) => ({ store: params[f.name], key })));
const envValue = (v) => (v == null ? "" : Array.isArray(v) ? v.join(",") : String(v));
function jobManifest({ name, namespace, template: t, instance: inst, params, image, trigger, scheduleId, slot }) {
  // hidden fields (and TASK_PARAMS, which contains them) come from the instance's task-hidden-<id>
  // Secret, so the Job spec never carries their values
  const hidden = new Set(inst.hidden || []), fromHidden = (key) => ({ valueFrom: { secretKeyRef: { name: `task-hidden-${inst.id}`, key } } });
  const env = [
    ...t.fields.map((f) => (hidden.has(f.name) ? { name: envName(f.name), ...fromHidden(envName(f.name)) } : { name: envName(f.name), value: envValue(params[f.name]) })),
    hidden.size ? { name: "TASK_PARAMS", ...fromHidden("TASK_PARAMS") } : { name: "TASK_PARAMS", value: JSON.stringify(params) },
    { name: "TASK_INSTANCE", value: inst.id }, { name: "TASK_NAME", value: inst.name }, { name: "TASK_RUN", value: name },
    { name: "TASK_TRIGGER", value: trigger }, { name: "TASK_DIR", value: "/task" }, { name: "HOME", value: "/work" },
    ...pickedKeys(t, params).map(({ store, key }) => ({ name: key, valueFrom: { secretKeyRef: { name: `env-${store}`, key } } })),
  ];
  const labels = { [L.run]: "1", [L.instance]: inst.id, [L.template]: t.name, [L.trigger]: trigger };
  const annotations = { [A.name]: inst.name, ...(scheduleId ? { [A.schedule]: scheduleId, [A.slot]: new Date(slot).toISOString() } : {}) };
  return {
    apiVersion: "batch/v1", kind: "Job",
    metadata: { name, namespace, labels, annotations },
    spec: {
      backoffLimit: 0, activeDeadlineSeconds: t.timeoutSeconds, ttlSecondsAfterFinished: RUN_TTL_SECONDS,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never", automountServiceAccountToken: false, enableServiceLinks: false,
          securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: "RuntimeDefault" } },
          containers: [{
            name: "task", image, command: command(t.run), workingDir: "/work", env,
            envFrom: t.stores.map((st) => ({ secretRef: { name: `env-${st}` } })),
            resources: { requests: { cpu: "50m", memory: "64Mi" }, limits: { memory: t.memory } },
            securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
            volumeMounts: [{ name: "task", mountPath: "/task", readOnly: true }, { name: "work", mountPath: "/work" }],
          }],
          volumes: [{ name: "task", configMap: { name, defaultMode: 0o755 } }, { name: "work", emptyDir: {} }],
        },
      },
    },
  };
}
// A Job (+ its newest pod, when given) as a run for the API.
function runView(job, pod) {
  const st = job.status || {}, md = job.metadata || {}, ann = md.annotations || {}, lab = md.labels || {};
  const cond = (type) => (st.conditions || []).find((c) => c.type === type && c.status === "True");
  const failed = cond("Failed");
  let phase = "starting";
  if (cond("Complete") || st.succeeded) phase = "succeeded";
  else if (failed || st.failed) phase = failed && failed.reason === "DeadlineExceeded" ? "timedout" : "failed";
  else if (job.spec && job.spec.suspend) phase = "stopped";
  else if (st.active && (st.ready || (pod && pod.status && pod.status.phase === "Running"))) phase = "running";
  const out = {
    name: md.name, instance: lab[L.instance], template: lab[L.template], trigger: lab[L.trigger] || "manual",
    schedule: ann[A.schedule] || null, slot: ann[A.slot] || null, instanceName: ann[A.name] || "",
    phase, createdAt: md.creationTimestamp || null, startedAt: st.startTime || null, finishedAt: st.completionTime || (failed && failed.lastTransitionTime) || null,
    reason: failed ? `${failed.reason || "Failed"}${failed.message ? ": " + failed.message : ""}` : null,
  };
  const cs = pod && pod.status && (pod.status.containerStatuses || [])[0];
  if (cs) {
    if (cs.state && cs.state.terminated) out.exitCode = cs.state.terminated.exitCode;
    if (cs.state && cs.state.waiting && cs.state.waiting.reason && cs.state.waiting.reason !== "ContainerCreating") out.waiting = `${cs.state.waiting.reason}${cs.state.waiting.message ? ": " + cs.state.waiting.message : ""}`;
  }
  if (!cs && pod && pod.status && pod.status.phase === "Pending") {
    const sch = (pod.status.conditions || []).find((c) => c.type === "PodScheduled" && c.status === "False");
    if (sch) out.waiting = `${sch.reason || "Unschedulable"}${sch.message ? ": " + sch.message : ""}`;
  }
  return out;
}
const isFinished = (r) => ["succeeded", "failed", "timedout", "stopped"].includes(r.phase);

// ---- I/O --------------------------------------------------------------------------------------
// deps: { k8s, git, store, notify? } — injected so the tests can fake the cluster
// deps.options(): the live option lists for `optionsFrom` fields
function create({ k8s, git, store, options = async () => ({}) }) {
  const ns = () => k8s.namespace();
  const jobsPath = (name) => `/apis/batch/v1/namespaces/${ns()}/jobs${name ? "/" + name : ""}`;
  const sel = (s) => "?labelSelector=" + encodeURIComponent(s);

  const loadTemplates = async ({ fresh = false } = {}) => {
    const [ts, sources] = await Promise.all([git.read((dir) => readTemplates(dir), { maxAgeMs: fresh ? 0 : 60000 }), options()]);
    return ts.map((t) => resolveOptions(t, sources));
  };
  async function template(name) {
    const t = (await loadTemplates()).find((x) => x.name === name);
    if (!t) throw bad(`no template "${name}" in ${TEMPLATES_DIR}`);
    if (t.error) throw bad(`template "${name}" is broken: ${t.error}`);
    return t;
  }

  // instances + schedules: read from the cluster for views, from git inside a write
  const parseState = (data) => {
    const j = (k) => { try { const v = JSON.parse((data && data[k]) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
    return { instances: j("instances.json"), schedules: j("schedules.json") };
  };
  async function getState() {
    const cm = await k8s.get("configmaps", TASKS_CM, { allow404: true });
    return parseState(cm && cm.data);
  }
  let chain = Promise.resolve();
  // fn(state) mutates the state in place (and may return a value); committed to git, then applied
  function update(message, fn) {
    const p = chain.then(async () => {
      let m = null, out;
      await git.transaction(message, async (dir) => {
        let data = null;
        try { data = JSON.parse(fs.readFileSync(path.join(dir, TASKS_PATH), "utf8")).data; } catch {}
        const st = data ? parseState(data) : await getState();
        out = await fn(st);
        m = { apiVersion: "v1", kind: "ConfigMap", metadata: { name: TASKS_CM, namespace: ns() },
          data: { "instances.json": JSON.stringify(st.instances, null, 1), "schedules.json": JSON.stringify(st.schedules, null, 1) } };
        git.writeYamlish(TASKS_PATH, m);
      });
      await k8s.apply(m);
      return out;
    });
    chain = p.catch(() => {});
    return p;
  }
  const findInstance = (st, id) => { const i = st.instances.find((x) => x.id === id); if (!i) throw Object.assign(new Error(`no such task instance: ${id}`), { status: 404 }); return i; };

  // the per-instance hidden values: Secret task-hidden-<id>, sops-encrypted in git like the secret stores
  const hiddenName = (id) => `task-hidden-${id}`;
  async function readHidden(id) {
    const sec = await k8s.get("secrets", hiddenName(id), { allow404: true });
    const d = sec ? k8s.decodeData(sec.data) : {};
    const out = {};
    for (const [k, v] of Object.entries(d)) if (k !== "TASK_PARAMS" && !k.startsWith("PARAM_")) { try { out[k] = JSON.parse(v); } catch { out[k] = v; } }
    return out;
  }
  async function writeHidden(id, values, fullParams) {
    const stringData = { TASK_PARAMS: JSON.stringify(fullParams) };
    for (const [k, v] of Object.entries(values)) { stringData[k] = JSON.stringify(v); stringData[envName(k)] = envValue(v); }
    const manifest = { apiVersion: "v1", kind: "Secret", type: "Opaque", metadata: { name: hiddenName(id), namespace: ns() }, stringData };
    await git.transaction(`jarvis: task instance ${id} hidden values`, () => git.writeEncryptedSecret(`${git.SECRETS_DIR}/${hiddenName(id)}.sops.yaml`, manifest));
    await k8s.apply(manifest);
  }
  async function deleteHidden(id) {
    await git.transaction(`jarvis: task instance ${id} hidden values removed`, () => git.removeFile(`${git.SECRETS_DIR}/${hiddenName(id)}.sops.yaml`));
    await k8s.delete("secrets", hiddenName(id));
  }

  async function saveInstance(id, body) {
    const b = body || {};
    const name = String(b.name || "").trim().slice(0, 80);
    if (!name) throw bad("a name is required");
    // the template is read BEFORE the write: git.read queues behind the transaction, so reading it
    // inside one waited on itself and wedged every git write in Jarvis
    const pre = id ? findInstance(await getState(), id) : null;
    const t = await template(pre ? pre.template : String(b.template || ""));
    const hide = Array.isArray(b.hide) ? b.hide.map(String) : [];
    if (!pre) checkParams(t, b.params); // validate early for a new instance (errors before any write)
    // hidden values are merged + written BEFORE the record (their own git commit + Secret), so the
    // record never names a hidden field whose value is not there yet
    const curHidden = pre && (pre.hidden || []).length ? await readHidden(pre.id) : {};
    const m = mergeParams(t, pre, curHidden, b, hide);
    const instId = pre ? pre.id : newId();
    if (m.hidden.length) await writeHidden(instId, m.secret, m.params);
    const saved = await update(`jarvis: task instance ${name}`, async (st) => {
      const cur = id ? findInstance(st, id) : null;
      if (cur && cur.template !== t.name) throw bad(`task instance ${id} changed template`);
      const extra = m.hidden.length ? { hidden: m.hidden, hiddenSet: m.hiddenSet } : {};
      if (cur) { Object.assign(cur, { name, params: m.visible, updatedAt: new Date().toISOString() }, extra); return cur; }
      const inst = { id: instId, template: t.name, name, params: m.visible, ...extra, createdAt: new Date().toISOString() };
      st.instances.push(inst);
      return inst;
    });
    return publicInstance(saved);
  }
  async function deleteInstance(id) {
    await update(`jarvis: delete task instance ${id}`, (st) => {
      findInstance(st, id);
      st.instances = st.instances.filter((x) => x.id !== id);
      st.schedules = st.schedules.filter((s) => s.instance !== id);
    });
    await deleteHidden(id).catch((e) => console.error("[tasks] delete hidden values:", e.message));
    if (ID_RE.test(id)) await k8s.call("DELETE", jobsPath() + sel(`${L.instance}=${id}`) + "&propagationPolicy=Background").catch((e) => console.error("[tasks] delete runs:", e.message));
  }
  async function saveSchedule(id, body) {
    const b = body || {};
    return update(`jarvis: task schedule`, (st) => {
      const cur = id ? st.schedules.find((s) => s.id === id) : null;
      if (id && !cur) throw Object.assign(new Error(`no such schedule: ${id}`), { status: 404 });
      const instance = cur ? cur.instance : String(b.instance || "");
      findInstance(st, instance);
      const time = fmtTime(parseTime(b.time != null ? b.time : cur && cur.time));
      const tz = checkTz(String(b.tz || (cur && cur.tz) || "Europe/London"));
      const enabled = b.enabled != null ? !!b.enabled : cur ? cur.enabled : true;
      // a change never fires a slot that has already passed (since = now)
      const s = { id: cur ? cur.id : newId(), instance, time, tz, enabled, since: Date.now(), createdAt: cur ? cur.createdAt : new Date().toISOString() };
      if (cur) Object.assign(cur, s); else st.schedules.push(s);
      return s;
    });
  }
  const deleteSchedule = (id) => update(`jarvis: delete task schedule ${id}`, (st) => {
    if (!st.schedules.some((s) => s.id === id)) throw Object.assign(new Error(`no such schedule: ${id}`), { status: 404 });
    st.schedules = st.schedules.filter((s) => s.id !== id);
  });

  async function listJobs(selector = `${L.run}=1`) {
    const j = await k8s.call("GET", jobsPath() + sel(selector));
    return (j.items || []).sort((a, b) => String(b.metadata.creationTimestamp).localeCompare(String(a.metadata.creationTimestamp)));
  }
  async function podOf(name) {
    const j = await k8s.call("GET", `/api/v1/namespaces/${ns()}/pods` + sel(`job-name=${name}`));
    return (j.items || []).sort((a, b) => String(b.metadata.creationTimestamp).localeCompare(String(a.metadata.creationTimestamp)))[0] || null;
  }

  // Start a run. 409 from k8s (the Job already exists) → `already` (a schedule slot that fired).
  async function startRun(instanceId, { trigger = "manual", scheduleId, slot } = {}) {
    const st = await getState();
    const inst = findInstance(st, instanceId);
    const t = await template(inst.template);
    const params = checkParams(t, (inst.hidden || []).length ? { ...inst.params, ...(await readHidden(inst.id)) } : inst.params);
    const cfg = await store.get();
    const image = t.image || cfg.taskImage;
    if (!image) throw bad("no task image pinned yet — the task-image workflow has not run");
    for (const s of t.stores) if (!cfg.environments[s]) throw bad(`template ${t.name} needs secret store "${s}", which does not exist`);
    for (const { store: s, key } of pickedKeys(t, params)) {
      const e = cfg.environments[s];
      if (!e) throw bad(`secret store "${s}" does not exist`);
      if (!Object.prototype.hasOwnProperty.call(e.secrets || {}, key)) throw bad(`secret store "${s}" has no ${key}`);
    }
    const name = runName(inst.id, { scheduleId, slot });
    const job = jobManifest({ name, namespace: ns(), template: t, instance: inst, params, image, trigger, scheduleId, slot });
    let made;
    try { made = await k8s.call("POST", jobsPath(), job); }
    catch (e) { if (e.status === 409) return { name, already: true }; throw e; }
    // the files ConfigMap is owned by the Job, so it goes when the Job is deleted (the pod waits for it)
    try {
      const files = await git.read((dir) => templateFiles(dir, t));
      await k8s.apply({ apiVersion: "v1", kind: "ConfigMap",
        metadata: { name, namespace: ns(), labels: { [L.run]: "1", [L.instance]: inst.id }, ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name, uid: made.metadata.uid }] },
        data: files.data, ...(Object.keys(files.binaryData).length ? { binaryData: files.binaryData } : {}) });
    } catch (e) {
      await k8s.call("DELETE", jobsPath(name) + "?propagationPolicy=Background", null, { allow404: true }).catch(() => {});
      throw e;
    }
    await prune(inst.id).catch((e) => console.error("[tasks] prune:", e.message));
    return { name, run: runView(made) };
  }
  async function prune(instanceId) {
    const jobs = await listJobs(`${L.instance}=${instanceId}`);
    for (const j of jobs.slice(KEEP_RUNS)) await k8s.call("DELETE", jobsPath(j.metadata.name) + "?propagationPolicy=Background", null, { allow404: true });
  }
  async function runs(instanceId) { return (await listJobs(`${L.instance}=${instanceId}`)).map((j) => runView(j)); }
  async function runDetail(name) {
    const job = await k8s.call("GET", jobsPath(name), null, { allow404: true });
    if (!job || !(job.metadata.labels || {})[L.run]) throw Object.assign(new Error(`no such run: ${name}`), { status: 404 });
    const pod = await podOf(name).catch(() => null);
    let log = "";
    if (pod) log = await k8s.call("GET", `/api/v1/namespaces/${ns()}/pods/${pod.metadata.name}/log?limitBytes=262144`, null, { text: true, allow404: true }).catch(() => "") || "";
    // Redaction goes by the run's instance's hidden Secret itself, not by its record (a record can be
    // briefly missing, e.g. while Flux re-applies an older jarvis-tasks revision) — and fails CLOSED:
    // a Secret that can't be read withholds the log rather than serving it raw.
    const instId = (job.metadata.labels || {})[L.instance];
    if (instId && log) {
      let hidden;
      try { hidden = await readHidden(instId); }
      catch (e) { return { run: runView(job, pod), log: `[log withheld: its hidden values could not be checked (${e.message})]` }; }
      log = redact(log, hiddenStrings(hidden));
    }
    return { run: runView(job, pod), log };
  }
  async function stopRun(name) {
    await runDetail(name);
    await k8s.call("PATCH", jobsPath(name), { spec: { suspend: true } }, { contentType: "application/merge-patch+json" });
  }

  // GET /api/tasks: templates, instances (+ their last run), schedules (+ next run)
  async function overview({ fresh = false } = {}) {
    const [templates, st, jobs, cfg] = await Promise.all([loadTemplates({ fresh }), getState(), listJobs().catch(() => []), store.get()]);
    const last = {};
    for (const j of jobs) { const id = (j.metadata.labels || {})[L.instance]; if (id && !last[id]) last[id] = runView(j); }
    const now = Date.now();
    return {
      taskImage: cfg.taskImage || null,
      templates,
      instances: st.instances.map((i) => ({ ...publicInstance(i), lastRun: last[i.id] || null, schedules: st.schedules.filter((s) => s.instance === i.id).length })),
      schedules: st.schedules.map((s) => ({ ...s, nextAt: s.enabled ? nextSlot(s, now) : null })),
    };
  }

  // Every tick: fire due schedule slots; DM once per failed scheduled run.
  const failedStarts = new Set(); // slots that could not even start, reported once
  async function tick({ ping, now = Date.now() } = {}) {
    const st = await getState();
    let jobs = null;
    for (const s of st.schedules) {
      const slot = dueSlot(s, now);
      if (slot == null) continue;
      jobs = jobs || await listJobs();
      const name = runName(s.instance, { scheduleId: s.id, slot });
      if (jobs.some((j) => j.metadata.name === name)) continue;
      try {
        const r = await startRun(s.instance, { trigger: "schedule", scheduleId: s.id, slot });
        if (!r.already) console.log(`[tasks] schedule ${s.id} fired ${name}`);
      } catch (e) {
        console.error(`[tasks] schedule ${s.id} could not start: ${e.message}`);
        const inst = st.instances.find((i) => i.id === s.instance);
        // remember the failed slot so it is reported once, not every tick (a Job-less marker)
        if (!failedStarts.has(name)) { failedStarts.add(name); if (ping) await ping(`Task “${inst ? inst.name : s.instance}” (daily ${s.time} ${s.tz}) could not start: ${e.message}`); }
      }
    }
    if (!ping) return;
    for (const j of jobs || await listJobs()) {
      const r = runView(j), ann = j.metadata.annotations || {};
      if (r.trigger !== "schedule" || !["failed", "timedout"].includes(r.phase) || ann[A.notified]) continue;
      let tail = "";
      try { tail = (await runDetail(r.name)).log.trimEnd().split("\n").slice(-15).join("\n").slice(-1200); } catch {}
      const sch = st.schedules.find((s) => s.id === r.schedule);
      await ping(`Scheduled task “${r.instanceName}”${sch ? ` (daily ${sch.time} ${sch.tz})` : ""} ${r.phase === "timedout" ? "timed out" : "failed"}${r.exitCode != null ? ` with exit code ${r.exitCode}` : ""}${r.reason ? ` — ${r.reason}` : ""}.${tail ? "\n```\n" + tail.replace(/```/g, "'''") + "\n```" : ""}`);
      await k8s.call("PATCH", jobsPath(r.name), { metadata: { annotations: { [A.notified]: new Date(now).toISOString() } } }, { contentType: "application/merge-patch+json" });
    }
  }

  return { loadTemplates, getState, overview, saveInstance, deleteInstance, saveSchedule, deleteSchedule, startRun, runs, runDetail, stopRun, tick };
}

module.exports = { create, parseTemplate, resolveOptions, readTemplates, checkParams, publicInstance, hiddenStrings, redact, mergeParams, jobManifest, runView, runName, nextSlot, lastSlot, dueSlot, isFinished, TEMPLATES_DIR, KEEP_RUNS };
