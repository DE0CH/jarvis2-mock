// Mock secrets-controller core (claude-env selfhost/SECRETS-CONTROLLER.md), small and in memory:
// everything it says is signed with its own P-256 key (made at start, never stored), every request is
// answered with a challenge, and a challenge only turns into a cert when the iPhone has signed exactly
// that challenge with its Secure Enclave key. Machines are fake (no Fly); sessions land in the mock's list.
//
// Wire format: a signed document is {payload: "<JSON text>", sig: "<base64 DER ECDSA-SHA256>"}; public
// keys travel as base64 of the 65-byte uncompressed X9.63 point (what CryptoKit's x963Representation is).
const crypto = require("crypto");

const SPKI_P256 = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");
const keyPair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pubRaw = (k) => k.export({ type: "spki", format: "der" }).subarray(-65);
const pubFromRaw = (b64) => crypto.createPublicKey({ key: Buffer.concat([SPKI_P256, Buffer.from(b64, "base64")]), format: "der", type: "spki" });
const nonceKey = crypto.randomBytes(32); // challenge nonces are derived from the request: nothing stored

function sign(obj) {
  const payload = JSON.stringify(obj);
  return { payload, sig: crypto.sign("sha256", Buffer.from(payload), keyPair.privateKey).toString("base64") };
}
function verify(doc, pub) {
  try { return crypto.verify("sha256", Buffer.from(doc.payload), pub, Buffer.from(doc.sig, "base64")); } catch { return false; }
}
const err = (status, message) => Object.assign(new Error(message), { status });

// known stores (the mock's fixed list); the sensitive mark only ever grows
const STORES = [
  { name: "default", keys: ["FLY_API_TOKEN", "GITHUB_TOKEN", "LOBSTER_TOKEN", "SERPAPI_KEY"], sensitive: false },
  { name: "scratch", keys: ["FOO"], sensitive: false },
  { name: "gmail", keys: ["GMAIL_WEB_CLIENT_ID", "GMAIL_WEB_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"], sensitive: true },
  { name: "proton", keys: ["PROTON_USER", "PROTON_PASSWORD"], sensitive: true },
];
const stores = () => STORES.map((s) => ({ ...s, keys: [...s.keys] }));

// the image every machine runs (a CI build); the phone shows it as "latest CI build"
const IMAGE = { hash: "sha256:" + crypto.createHash("sha256").update("jarvis2-mock-session-image").digest("hex"), builtAt: new Date().toISOString(), label: "latest CI build" };

let phonePub = null;        // the iPhone's signing key, learned on first use (setup is undesigned)
const started = new Map();  // machine id -> started machine
const used = new Set();     // challenges already answered (the mock keeps it so a replay is visible)

function startMachine() {
  const id = "j2" + crypto.randomBytes(5).toString("hex");
  const enc = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }), sig = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const m = { id, imageHash: IMAGE.hash, encryptionKey: pubRaw(enc.publicKey).toString("base64"), signingKey: pubRaw(sig.publicKey).toString("base64") };
  started.set(id, m);
  return m;
}

function succession({ predecessor, machine, stores: picked, options }) {
  if (predecessor !== null) throw err(400, "the mock only starts new lines (predecessor null)");
  const m = started.get(machine);
  if (!m) throw err(404, "no such started machine");
  const known = new Set(STORES.map((s) => s.name));
  const set = [...new Set(picked || [])].sort();
  if (!set.length) throw err(400, "pick at least one store");
  for (const n of set) if (!known.has(n)) throw err(400, `unknown store: ${n}`);
  const request = { kind: "succession", predecessor: null, machine: m, stores: set, sensitive: set.filter((n) => STORES.find((s) => s.name === n).sensitive), options: { harness: options && options.harness === "opencode" ? "opencode" : "claude" }, image: IMAGE };
  const nonce = crypto.createHmac("sha256", nonceKey).update(JSON.stringify(request)).digest("base64url");
  return sign({ kind: "challenge", nonce, request });
}

function respond({ challenge, phoneKey, phoneSig }) {
  if (!challenge || !verify(challenge, keyPair.publicKey)) throw err(400, "not a challenge this core signed");
  const c = JSON.parse(challenge.payload);
  if (c.kind !== "challenge") throw err(400, "not a challenge");
  if (!phonePub) phonePub = phoneKey;
  if (phoneKey !== phonePub) throw err(403, "not the registered iPhone key");
  if (!verify({ payload: challenge.payload, sig: phoneSig }, pubFromRaw(phoneKey))) throw err(403, "the iPhone's signature doesn't cover this challenge");
  used.add(c.nonce);
  return sign({ kind: "succession-cert", predecessor: c.request.predecessor, machine: c.request.machine, stores: c.request.stores, options: c.request.options, image: c.request.image, nonce: c.nonce });
}

function routes(app, { sessions }) {
  const h = (fn) => (req, res) => { try { res.json(fn(req.body || {}, req)); } catch (e) { res.status(e.status || 500).json(sign({ kind: "error", error: e.message })); } };
  app.get("/core/key", (req, res) => res.json({ key: pubRaw(keyPair.publicKey).toString("base64") }));
  app.post("/core/stores", h((b) => sign({ kind: "stores", nonce: String(b.nonce || ""), stores: stores().map(({ name, keys, sensitive }) => ({ name, keys: keys.length, sensitive })), image: IMAGE })));
  app.post("/core/start", h(() => sign({ kind: "started", machine: startMachine() })));
  app.post("/core/succession", h((b) => succession(b)));
  // the iPhone's answer + the non-security session fields (prompt, title…) the normal-mode form collected
  app.post("/core/respond", h((b) => {
    const cert = respond(b);
    const c = JSON.parse(cert.payload), s = b.session || {};
    const model = c.options.harness === "opencode" ? "openrouter/z-ai/glm-5.3" : (typeof s.model === "string" && s.model.startsWith("claude-") ? s.model : "claude-opus-5-5");
    sessions.push({
      id: c.machine.id, name: "s-" + c.machine.id, state: "created", region: "fra", created: new Date().toISOString(),
      label: String(s.label || ""), environment: c.stores.join(","), repos: (s.repos || []).join(" "), permissionMode: s.permissionMode === "bypass" ? "bypass" : "auto",
      model, harness: c.options.harness, autoPause: s.autoPause === false ? "off" : "on", oneShot: !!s.oneShot, guest: "4×shared · 4 GB", aiTitle: "",
      createRequestId: s.requestId,
    });
    setTimeout(() => { const x = sessions.find((y) => y.id === c.machine.id); if (x) { x.state = "started"; x.status = "idle"; } }, 4000);
    return { cert, id: c.machine.id };
  }));
}

module.exports = { routes, stores, sign, verify, pubFromRaw, _test: { keyPair, pubRaw, startMachine, succession, respond, reset: () => { phonePub = null; } } };
