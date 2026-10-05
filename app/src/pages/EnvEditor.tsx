// Jarvis never sends secret values: the editor lists key names and lets you set a new value (blank =
// unchanged), delete a key, or add keys. Only the changes are sent. In the iPhone app, Show values fetches
// the store's sops file (values still encrypted) and decrypts it on the phone with the Secure Enclave
// vault key (Settings → Vault key) after Face ID; the plaintext lives only in this page's state.
import { Fragment, useState } from "react";
import { View } from "react-native";
import { api } from "../lib/api";
import { useStore, refresh, ask } from "../lib/store";
import { Button, Flex, IconButton, Lbl, Muted, P, Spinner, TextArea, TextField } from "../ui/kit";
import { BtnLabel, useBusy } from "../ui/bits";
import { Page, closePage } from "../ui/page";
import * as Clipboard from "expo-clipboard";
import { vault } from "../../modules/sops-vault";
import { toast } from "../lib/store";

type SopsFile = { prefix: string; values: Record<string, string>; age: { recipient: string; enc: string }[] };

function parseVal(v: string) { if (v.startsWith('"') && v.endsWith('"')) { try { return JSON.parse(v); } catch {} } return v; }

export function EnvEditor({ name }: { name: string }) {
  const envs = useStore((s) => s.state.environments) || {};
  const keys = name ? ((envs[name] || {}).keys || []).slice().sort() : [];
  const [id, setId] = useState(name);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [del, setDel] = useState<Set<string>>(new Set());
  const [add, setAdd] = useState("");
  const [busy, run, guard] = useBusy();
  const [err, setErr] = useState("");
  const [plain, setPlain] = useState<Record<string, string> | null>(null);
  const canReveal = !!name && !!vault && (() => { try { return !!vault.recipient(); } catch { return false; } })();
  const reveal = () => guard(async () => {
    setErr("");
    await run("Decrypting…", async () => {
      try {
        const f = await api<SopsFile>("GET", `api/environments/${encodeURIComponent(name)}/sops`);
        setPlain(await vault!.decrypt(`Show the values of "${name}"`, f.prefix, f.values, f.age));
      } catch (e: any) { setErr(e.message); }
    });
  });
  const copy = async (k: string) => { if (plain && k in plain) { await Clipboard.setStringAsync(plain[k]); toast(`${k} copied.`, "ok"); } };
  const save = () => guard(async () => {
    const nm = id.trim(); setErr("");
    if (!nm) { setErr("Environment id required."); return; }
    const secrets: Record<string, any> = {};
    for (const k of keys) { if (del.has(k)) secrets[k] = ""; else if (vals[k]) secrets[k] = parseVal(vals[k]); }
    for (const line of add.split("\n")) {
      const i = line.indexOf("="); if (i < 1) continue;
      const k = line.slice(0, i).trim(), v = line.slice(i + 1);
      if (!v) { setErr(`"${k}": empty value (to delete an existing key use its ✕ button).`); return; }
      secrets[k] = parseVal(v);
    }
    if (!Object.keys(secrets).length && name) { closePage(); return; }
    if (del.size && !(await ask({ title: `Delete ${[...del].join(", ")} from "${nm}"?`, action: "Delete and save", danger: true }))) return;
    await run("Saving…", async () => {
      try { await api("POST", "api/environments", { name: nm, secrets }); closePage(); await refresh(false); }
      catch (e: any) { setErr(e.message); }
    });
  });
  return (
    <Page title={name ? "Edit environment" : "New environment"} onSubmit={busy ? undefined : save}
      right={<Button id="ev-save" disabled={!!busy} onPress={save}>{busy ? <><Spinner /><BtnLabel>{busy}</BtnLabel></> : "Save"}</Button>}>
      <Lbl>Environment id</Lbl>
      <TextField id="ev-title" autoComplete="off" autoCorrect={false} autoCapitalize="none" value={id} editable={!name} placeholder="e.g. default (lowercase, dashes)" onChangeText={setId} />
      {keys.length > 0 && <Lbl>Existing keys — type a new value to update, leave blank to keep</Lbl>}
      {canReveal && !plain && <Flex mt={3}><Button variant="soft" color="gray" disabled={!!busy} onPress={reveal} id="ev-reveal">Show values</Button></Flex>}
      {keys.map((k) => { const d = del.has(k); return (<Fragment key={k}>
        <View {...({ dataSet: { k } } as any)} style={{ flexDirection: "row", gap: 8, alignItems: "center", marginVertical: 6, opacity: d ? 0.5 : 1 }}>
          <TextField secureTextEntry style={{ flex: 1 }} mono placeholder={`${k}  (unchanged)`} autoComplete="new-password" autoCapitalize="none" autoCorrect={false} disabled={d} value={d ? "" : (vals[k] || "")} onChangeText={(v) => setVals((x) => ({ ...x, [k]: v }))} />
          {plain && k in plain && !d && <Button variant="soft" color="gray" label={`copy ${k}`} onPress={() => copy(k)}>Copy</Button>}
          {d ? <Button variant="soft" color="gray" onPress={() => setDel((s) => { const n = new Set(s); n.delete(k); return n; })}>undo</Button>
            : <IconButton variant="soft" color="red" label={`delete ${k}`} onPress={() => setDel((s) => new Set(s).add(k))}>✕</IconButton>}
        </View>
        {plain && k in plain && !d && <P size={1} mono selectable color="gray" mb={2} id={`ev-plain-${k}`}>{plain[k]}</P>}
        </Fragment>); })}
      <Lbl>Add keys (KEY=VALUE, one per line)</Lbl>
      <TextArea id="ev-add" rows={3} mono autoCapitalize="none" autoCorrect={false} placeholder="NEW_KEY=value" value={add} onChangeText={setAdd} />
      <Muted mt={2}>Committed to git encrypted (sops), then applied. Values are write-only on the web; the iPhone app can show them with its vault key. Multi-line values: wrap in JSON quotes ("...\n...").</Muted>
      {!!err && <P size={2} color="red" mt={3}>{err}</P>}
    </Page>
  );
}
