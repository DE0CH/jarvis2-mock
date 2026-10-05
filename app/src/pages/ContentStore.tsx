// One content store's files: the list (path, size), upload (each picked file goes straight to the
// store under an optional folder, with progress), and delete a file. Uploads replace a file of the
// same path. Sessions already running keep the copy they pulled at boot.
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { api } from "../lib/api";
import { ask, exclusive, failed, loadContent, toast } from "../lib/store";
import { pickFiles, pickDocuments, sendFile, type Picked } from "../lib/files";
import { Button, Flex, Lbl, Muted, P, Progress, Spinner, TextField, Code } from "../ui/kit";
import { Page } from "../ui/page";
import { fmtBytes } from "../views/Content";

const MAX_BYTES = 25 * 1024 * 1024; // the cf-tunnel caps a request body at 25 MB
type File = { path: string; size: number; modified: string };
type Up = { key: number; path: string; pct: number; err?: string };

export function ContentStorePage({ name }: { name: string }) {
  const [files, setFiles] = useState<File[] | null>(null), [err, setErr] = useState("");
  const [folder, setFolder] = useState(""), [ups, setUps] = useState<Up[]>([]), [deleting, setDeleting] = useState<Set<string>>(new Set());
  const seq = useRef(0), alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const load = async () => {
    try { const j = await api<{ files: File[] }>("GET", `api/content/${encodeURIComponent(name)}/files`); if (alive.current) { setFiles(j.files || []); setErr(""); } }
    catch (e: any) { if (alive.current) setErr(e.message); }
  };
  useEffect(() => { load(); }, [name]);
  const dir = folder.trim().replace(/^\/+|\/+$/g, "");
  async function add(list: Picked[]) {
    const todo = list.filter((f) => { if (f.size > MAX_BYTES) { toast(`“${f.name}” is over 25 MB`, "error"); return false; } return true; });
    for (const f of todo) {
      const path = (dir ? dir + "/" : "") + f.name, key = ++seq.current;
      setUps((u) => [...u, { key, path, pct: 0 }]);
      try {
        await sendFile(`api/content/${encodeURIComponent(name)}/file`, { "x-content-path": encodeURIComponent(path) }, f, f.name, (pct) => setUps((u) => u.map((x) => (x.key === key ? { ...x, pct } : x))));
        setUps((u) => u.filter((x) => x.key !== key));
      } catch (e: any) { setUps((u) => u.map((x) => (x.key === key ? { ...x, err: e.message } : x))); }
    }
    await load(); loadContent(true);
  }
  const pick = async (fn: () => Promise<Picked[]>) => { try { await add(await fn()); } catch (e: any) { toast("Could not open the picker: " + (e?.message || e), "error"); } };
  async function del(p: string) {
    if (!(await ask({ title: `Delete ${p}?`, detail: `Removed from the “${name}” store. Sessions that already pulled it keep their copy.`, action: "Delete file", danger: true }))) return;
    await exclusive("cfile:" + name + "/" + p, async () => {
      setDeleting((s) => new Set(s).add(p));
      try { await api("DELETE", `api/content/${encodeURIComponent(name)}/file?path=${encodeURIComponent(p)}`); await load(); loadContent(true); }
      catch (e: any) { failed(e, "Could not delete: "); }
      finally { setDeleting((s) => { const n = new Set(s); n.delete(p); return n; }); }
    });
  }
  return (
    <Page title={name} id="content-page">
      <Muted>In a session started with this store: <Code>{`~/content/${name}/`}</Code>. Claude uploads its changes back with <Code>{`content-sync push ${name}`}</Code>.</Muted>
      <Lbl>Upload</Lbl>
      <TextField id="cs-folder" autoComplete="off" autoCapitalize="none" autoCorrect={false} placeholder="Folder inside the store (optional), e.g. notes/2026" value={folder} onChangeText={setFolder} />
      <Flex gap={2} mt={2} wrap>
        <Button variant="soft" id="cs-add" onPress={() => pick(pickFiles)}>Add files</Button>
        {pickDocuments && <Button variant="soft" onPress={() => pick(pickDocuments!)}>Add documents</Button>}
      </Flex>
      <Muted mt={1}>Up to 25 MB per file. A file with the same path is replaced.</Muted>
      {ups.map((u) => (
        <View key={u.key} style={{ marginTop: 8 }}>
          <P size={2}>{u.path}</P>
          <P size={1} color={u.err ? "red" : "gray"}>{u.err ? `Failed: ${u.err}` : u.pct ? `Uploading ${u.pct}%` : "Preparing…"}</P>
          {!u.err && <Progress mt={1} size={1} value={u.pct} />}
        </View>
      ))}
      <Lbl>Files</Lbl>
      {!!err && <P size={2} color="red">{err}</P>}
      {files === null ? (!err && <Flex gap={2} align="center"><Spinner /><Muted>Loading…</Muted></Flex>)
        : !files.length ? <Muted>No files yet.</Muted>
        : files.map((f) => (
          <Flex key={f.path} align="center" gap={2} mt={1} data={{ cfile: f.path }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <P size={2} selectable>{f.path}</P>
              <P size={1} color="gray">{fmtBytes(f.size)}{f.modified ? " · " + new Date(f.modified).toLocaleString() : ""}</P>
            </View>
            {deleting.has(f.path) ? <Button variant="ghost" color="gray" size={1} disabled><Spinner /></Button>
              : <Button variant="ghost" color="red" size={1} onPress={() => del(f.path)} label={`Delete ${f.path}`}>Delete</Button>}
          </Flex>
        ))}
    </Page>
  );
}
