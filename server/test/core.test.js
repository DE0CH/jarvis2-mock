// The mock core end to end: a phone key signs exactly the challenge, and nothing else turns into a cert.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const core = require("../core");
const { keyPair, pubRaw, startMachine, succession, respond, reset } = core._test;

const phone = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const phoneKey = pubRaw(phone.publicKey).toString("base64");
const phoneSign = (payload) => crypto.sign("sha256", Buffer.from(payload), phone.privateKey).toString("base64");

test("a new line: challenge → phone signature → core-signed cert", () => {
  reset();
  const m = startMachine();
  const ch = succession({ predecessor: null, machine: m.id, stores: ["gmail", "default"], options: { harness: "claude" } });
  assert.ok(core.verify(ch, keyPair.publicKey));
  const req = JSON.parse(ch.payload).request;
  assert.deepEqual(req.stores, ["default", "gmail"]);
  assert.deepEqual(req.sensitive, ["gmail"]);
  const cert = respond({ challenge: ch, phoneKey, phoneSig: phoneSign(ch.payload) });
  assert.ok(core.verify(cert, keyPair.publicKey));
  assert.equal(JSON.parse(cert.payload).machine.id, m.id);
});

test("a signature over anything else, an altered challenge or another phone is refused", () => {
  reset();
  const m = startMachine();
  const ch = succession({ predecessor: null, machine: m.id, stores: ["default"], options: {} });
  assert.throws(() => respond({ challenge: ch, phoneKey, phoneSig: phoneSign("something else") }), /doesn't cover/);
  const altered = { payload: ch.payload.replace('"default"', '"gmail"'), sig: ch.sig };
  assert.throws(() => respond({ challenge: altered, phoneKey, phoneSig: phoneSign(altered.payload) }), /not a challenge this core signed/);
  respond({ challenge: ch, phoneKey, phoneSig: phoneSign(ch.payload) });
  const other = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  assert.throws(() => respond({ challenge: ch, phoneKey: pubRaw(other.publicKey).toString("base64"), phoneSig: crypto.sign("sha256", Buffer.from(ch.payload), other.privateKey).toString("base64") }), /registered iPhone key/);
});

test("unknown stores and machines are refused", () => {
  const m = startMachine();
  assert.throws(() => succession({ predecessor: null, machine: m.id, stores: ["nope"] }), /unknown store/);
  assert.throws(() => succession({ predecessor: null, machine: "zz", stores: ["default"] }), /no such started machine/);
});
