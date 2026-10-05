// Content tab: the content stores — named folders of files on the Storage Box that a session can be
// started with (New Session → Content stores); each is pulled into ~/content/<store>/ at boot and the
// session pushes changes back with `content-sync push`. Create / delete here; a store's files open
// on their own page (upload, delete).
import { api } from "../lib/api";
import { useStore, getStore, ask, askText, exclusive, pend, failed, loadContent, toast, type ContentStore } from "../lib/store";
import { Button, Card, Flex, Heading, Muted, P, Spinner } from "../ui/kit";
import { PButton } from "../ui/bits";
import { Cards } from "../ui/cards";
import { openPage } from "../ui/page";

export const fmtBytes = (n: number) => (n >= 1073741824 ? (n / 1073741824).toFixed(1) + " GB" : n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? Math.round(n / 1024) + " KB" : n + " B");
const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$/;

// reload (bypassing Jarvis's listing cache) until the list satisfies pred: two-phase, never optimistic
export async function settleContent(pred: (l: ContentStore[]) => boolean, maxMs = 15000) {
  const until = Date.now() + maxMs;
  for (;;) { await loadContent(true); if (pred(getStore().content.stores) || Date.now() > until) return; await new Promise((r) => setTimeout(r, 1000)); }
}

export async function addContentStore() {
  const name = await askText({
    title: "New content store",
    detail: "A folder of files on the Storage Box. Sessions started with it get it in ~/content/<name>/.",
    action: "Create",
    input: { heading: "Name", label: "Name", placeholder: "e.g. cv-docs (lowercase, digits, dashes)", max: 42 },
  });
  if (!name) return;
  if (!NAME_RE.test(name)) { toast("Use lowercase letters, digits and dashes (not starting or ending with a dash).", "error"); return; }
  await exclusive("content:add", async () => {
    pend("content:add", "Creating…");
    try { await api("POST", "api/content", { name }); await settleContent((l) => l.some((s) => s.name === name)); openPage("content", { name }); }
    catch (e: any) { failed(e, "Could not create the store: "); }
    finally { pend("content:add", null); }
  });
}

async function del(n: string) {
  if (!(await ask({ title: `Delete content store "${n}"?`, detail: "Every file in it is removed from the Storage Box. Running sessions keep their local copy in ~/content but can no longer push to it.", action: "Delete store", danger: true }))) return;
  await exclusive("content:" + n, async () => {
    pend("content:" + n, "Deleting…");
    try { await api("DELETE", "api/content/" + encodeURIComponent(n)); await settleContent((l) => !l.some((s) => s.name === n)); }
    catch (e: any) { failed(e, "Could not delete: "); }
    finally { pend("content:" + n, null); }
  });
}

export function Content() {
  const c = useStore((s) => s.content), pending = useStore((s) => s.pending);
  if (!c.loaded) return c.err ? <P size={2} color="red">{"Could not list content stores: " + c.err}</P> : <Flex gap={2} align="center"><Spinner /><Muted>Loading…</Muted></Flex>;
  return (
    <>
      {!!c.err && <P size={2} color="red" mb={2}>{"Could not refresh: " + c.err}</P>}
      {!c.stores.length && <Muted>No content stores yet. A content store is a folder of files that sessions can start with, in ~/content/&lt;name&gt;/.</Muted>}
      <Cards>
        {c.stores.map((s) => (
          <Card key={s.name} dim={pending.has("content:" + s.name)} data={{ content: s.name }}>
            <Flex justify="space-between" align="flex-start" gap={2} mb={1}><Heading size={3} style={{ flex: 1 }}>{s.name}</Heading><P size={1} color="gray">{s.files} file{s.files === 1 ? "" : "s"} · {fmtBytes(s.bytes)}</P></Flex>
            <Muted>In sessions: ~/content/{s.name}/</Muted>
            <Flex gap={2} pt={3} style={{ marginTop: "auto" }}>
              <Button variant="soft" color="gray" onPress={() => openPage("content", { name: s.name })}>Files</Button>
              <PButton pkey={"content:" + s.name} color="red" variant="soft" onPress={() => del(s.name)} label="Delete" />
            </Flex>
          </Card>
        ))}
      </Cards>
      {pending.has("content:add") && <Flex gap={2} align="center" mt={3}><Spinner /><Muted>Creating…</Muted></Flex>}
    </>
  );
}
