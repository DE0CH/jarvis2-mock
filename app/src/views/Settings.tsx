import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { api, fromNow, type Usage, type UsageLimit } from "../lib/api";
import { useStore, pend, refresh, toast, failed, exclusive, ask } from "../lib/store";
import { Box, Button, Card, Code, Flex, Heading, Muted, P, Progress, Text } from "../ui/kit";
import { PButton } from "../ui/bits";
import { Cards } from "../ui/cards";
import { isWeb } from "../ui/overlays";
import * as Clipboard from "expo-clipboard";
import { vault } from "../../modules/sops-vault";

// "Session (5 h)" / "Weekly · all models" / "Weekly · Fable" — the windows the CLI's /usage lists
function limitLabel(l: UsageLimit) {
  const scope = l.model || l.surface;
  if (l.group === "session") return "Session (5 h)";
  if (l.group === "weekly") return scope ? "Weekly · " + scope : "Weekly · all models";
  return (scope ? scope + " · " : "") + l.kind.replace(/_/g, " ");
}
function money(v: number, currency: string, dp: number) {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: dp }).format(v / Math.pow(10, dp)); }
  catch { return (v / Math.pow(10, dp)).toFixed(dp) + " " + currency; }
}
// links leave the app: a Safari sheet in the app, a new tab on the web
export function openExternal(url: string) {
  if (isWeb) window.open(url, "_blank", "noopener"); else WebBrowser.openBrowserAsync(url);
}
function UsageCard() {
  const hasCreds = useStore((s) => s.state.hasCreds);
  const [u, setU] = useState<Usage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // latest request wins: a slow cached load must not land over a forced refresh's fresher answer
  const seq = useRef(0);
  async function load(force: boolean) {
    const n = ++seq.current;
    if (force) pend("usage", "Refreshing…");
    try { const r = await api<Usage>("GET", "api/usage" + (force ? "?refresh=1" : "")); if (n === seq.current) { setU(r); setErr(null); } }
    catch (e: any) { if (n === seq.current) setErr(e.message); }
    if (force) pend("usage", null);
  }
  useEffect(() => { if (hasCreds) load(false); }, [hasCreds]);
  return (
    <Card><Heading size={3} mb={1}>Usage</Heading>
      {!hasCreds ? <Muted>Sign in to see the remaining quota.</Muted>
        : !u && !err ? <Muted>Loading…</Muted>
        : !u ? <P size={2} color="red">{err}</P>
        : <>
          {u.limits.length === 0 && <Muted>No rate-limit windows reported.</Muted>}
          {u.limits.map((l) => {
            const used = Math.max(0, Math.min(100, l.percent));
            const color = used >= 90 ? "red" : used >= 75 ? "amber" : "green";
            return (
              <Box key={l.kind + (l.model || "") + (l.surface || "")} mt={3}>
                <Flex justify="space-between" align="baseline" gap={2}>
                  <P size={2} weight="medium" style={{ flex: 1 }}>{limitLabel(l)}</P>
                  <P size={2} color={color} weight="bold">{used}% used</P>
                </Flex>
                <Progress value={used} color={color} mt={1} />
                <Muted mt={1}>{100 - used}% left{l.resetsAt ? " · resets " + fromNow(l.resetsAt) : ""}</Muted>
              </Box>
            );
          })}
          {u.extraUsage && <Muted mt={3}>Extra usage: {u.extraUsage.enabled
            ? `${money(u.extraUsage.usedCredits, u.extraUsage.currency, u.extraUsage.decimalPlaces)} of ${money(u.extraUsage.monthlyLimit, u.extraUsage.currency, u.extraUsage.decimalPlaces)} this month${u.extraUsage.spendLimitReached ? " · spend limit reached" : ""}`
            : `off${u.extraUsage.disabledReason ? " (" + u.extraUsage.disabledReason.replace(/_/g, " ") + ")" : ""}`}</Muted>}
          <Muted mt={2}>Fetched {fromNow(u.fetchedAt)}{u.stale ? <> · <Text color="red">showing the last good reading — refresh failed: {u.error}</Text></> : ""}{err && !u.stale ? <> · <Text color="red">{err}</Text></> : ""}</Muted>
        </>}
      {hasCreds && <Flex mt={3}><PButton pkey="usage" variant="soft" color="gray" onPress={() => load(true)} label="Refresh" /></Flex>}
    </Card>
  );
}

type Device = { id: string; name: string; model: string; createdAt: number; lastSeenAt: number };
// Paired Jarvis app installs (iPhone/iPad). Pairing happens in the app itself (it signs in once
// through the Access login); here they can be revoked.
function DevicesCard() {
  const [list, setList] = useState<Device[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function load() {
    try { const r = await api<{ devices: Device[] }>("GET", "api/devices"); setList(r.devices); setErr(null); }
    catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []);
  const remove = (d: Device) => exclusive("devdel-" + d.id, async () => {
    if (!(await ask({ title: "Remove " + d.name + "?", detail: "Its login is revoked at once; the app on it has to sign in and pair again.", action: "Remove", danger: true }))) return;
    pend("devdel-" + d.id, "Removing…");
    try { await api("DELETE", `api/devices/${d.id}`); toast(d.name + " removed.", "ok"); await load(); }
    catch (e: any) { failed(e); }
    pend("devdel-" + d.id, null);
  });
  return (
    <Card><Heading size={3} mb={1}>Devices</Heading>
      <Muted>The Jarvis app on your iPhone (TestFlight). Each install pairs once through the Cloudflare login and gets its own login.</Muted>
      {err ? <P size={2} color="red" mt={2}>{err}</P>
        : !list ? <Muted mt={2}>Loading…</Muted>
        : list.length === 0 ? <Muted mt={2}>No devices paired yet.</Muted>
        : list.map((d) => (
          <Box key={d.id} mt={3}>
            <P size={2} weight="medium">{d.name}</P>
            <Muted>{d.model} · paired {fromNow(new Date(d.createdAt))}</Muted>
            <Flex gap={2} mt={2}>
              <PButton pkey={"devdel-" + d.id} variant="soft" color="red" onPress={() => remove(d)} label="Remove" />
            </Flex>
          </Box>
        ))}
    </Card>
  );
}

// This iPhone's vault key: a P-256 key made inside the Secure Enclave, used with Face ID to decrypt secret
// store values on the phone (Edit environment → Show values). Its public key is added to .sops.yaml by hand,
// after which every store is also encrypted to it. App only: the web has no Enclave.
function VaultCard() {
  const [rec, setRec] = useState<string | null>(() => { try { return vault ? vault.recipient() : null; } catch { return null; } });
  const v = vault;
  if (!v) return null;
  const create = () => exclusive("vaultkey", async () => {
    if (rec && !(await ask({ title: "Replace the vault key?", detail: "The old key is deleted; stores stay unreadable on this phone until the new public key is in .sops.yaml and they are re-encrypted.", action: "Replace", danger: true }))) return;
    pend("vaultkey", "Creating…");
    try { if (rec) await v.deleteKey(); setRec(await v.createKey()); toast("Vault key created. Send its public key to Claude.", "ok"); }
    catch (e: any) { failed(e); }
    pend("vaultkey", null);
  });
  const copy = async () => { if (rec) { await Clipboard.setStringAsync(rec); toast("Public key copied.", "ok"); } };
  return (
    <Card><Heading size={3} mb={1}>Vault key</Heading>
      <Muted>A key made inside this iPhone's Secure Enclave. It never leaves the phone, and every use needs Face ID. Once its public key is a recipient in .sops.yaml, Edit environment → Show values decrypts a store here.</Muted>
      {!v.isAvailable() ? <P size={2} color="red" mt={2}>This device has no Secure Enclave.</P>
        : rec ? <><P size={1} mono selectable mt={3} id="vault-recipient">{rec}</P>
          <Flex gap={2} mt={3}><Button variant="soft" color="gray" onPress={copy} id="vault-copy">Copy public key</Button><PButton pkey="vaultkey" variant="soft" color="red" onPress={create} label="Replace key" /></Flex></>
        : <Flex mt={3}><PButton pkey="vaultkey" onPress={create} label="Create vault key" id="vault-create" /></Flex>}
    </Card>
  );
}

export function Settings({ onRelogin }: { onRelogin: () => void }) {
  const st = useStore((s) => s.state);
  const c = st.creds || {};
  const exp = c.expiresAt ? new Date(c.expiresAt) : null;
  const refreshCreds = () => exclusive("credrefresh", async () => {
    pend("credrefresh", "Refreshing…");
    try { const r = await api("POST", "api/credentials/refresh"); toast(r.refreshed ? "Token refreshed. Valid until " + new Date(r.expiresAt).toLocaleString() + "." : "Token was still fresh (valid until " + new Date(r.expiresAt).toLocaleString() + ").", "ok"); }
    catch (e: any) { failed(e); }
    await refresh(false); pend("credrefresh", null);
  });
  return (
    <View>
      <Cards>
        <Card><Heading size={3} mb={1}>Claude account</Heading>
          <Muted>{st.hasCreds ? `Signed in${c.subscriptionType ? " · " + c.subscriptionType : ""}${exp ? " · access token " + (exp > new Date() ? "expires " : "expired ") + fromNow(exp) : ""}` : "Not signed in"}</Muted>
          {c.stale && <P size={2} color="red">Token refresh rejected: {c.error || ""}</P>}
          <Muted mt={2}>Runs the real <Code>claude auth login</Code> on the controller (in the auth-broker pod, which Jarvis rollouts never restart): you open the link, sign in, and paste the code back here.{(st.auth || {}).unavailable ? <> <Text color="red" weight="bold">Auth broker unreachable</Text> — check the auth-broker pod.</> : null} New sessions use the stored credentials; Jarvis refreshes them before each start and running sessions push their refreshed copy back.</Muted>
          <Flex gap={2} mt={3}><PButton pkey="auth" onPress={onRelogin} label="Re-login" id="relogin" />{st.hasCreds && <PButton pkey="credrefresh" variant="soft" color="gray" onPress={refreshCreds} label="Refresh token" />}</Flex>
        </Card>
        <UsageCard />
        <DevicesCard />
        <VaultCard />
        <Card><Heading size={3} mb={1}>Session image</Heading>
          <Muted>{st.sessionImage || "none pinned yet"}</Muted>
          <Muted mt={2}>Built by GitHub Actions (<Code>session-image</Code> workflow) on every push that touches <Code>selfhost/session-image/</Code>, pushed to the public package <Code>ghcr.io/de0ch/claude-sessions</Code> and pinned into <Code>selfhost/k8s/config/jarvis-config.yaml</Code>; Flux applies the ref within a minute and the next session boots from it. To rebuild without a code change, re-run the workflow on GitHub. Nothing builds inside Jarvis, so rollouts can't lose a build.</Muted>
          <Flex mt={3}><Button variant="soft" color="gray" onPress={() => openExternal("https://github.com/DE0CH/claude-env/actions/workflows/session-image.yml")}>Workflow runs ↗</Button></Flex>
        </Card>
        <Card><Heading size={3} mb={1}>Controller</Heading>
          <Muted>jarvis v{st.version || "?"} · Fly app {st.flyApp || ""}</Muted>
          <Muted mt={2}>Everything here is reconciled by Flux from the claude-env repo (selfhost/k8s). Edits made in this dashboard are committed back to git (secrets encrypted with sops) and applied immediately.</Muted>
        </Card>
      </Cards>
    </View>
  );
}
