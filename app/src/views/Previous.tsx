// Previous sessions: the sessions destroyed from this dashboard, from the index Jarvis writes
// when it archives one (api/records — never a scan of the Storage Box). Restore starts a NEW
// session with the recorded settings that resumes the conversation from the archived transcript;
// the old working tree is not part of an archive, so its repos come back as fresh clones.
import { useState } from "react";
import { api, ago, type PrevSession, type SearchHit } from "../lib/api";
import { useStore, getStore, pend, refresh, settle, setTab, loadPrevious, askText, askTextCheck, toast, failed, exclusive } from "../lib/store";
import { RESUME_PROMPT, API_PROXY_CHECK } from "./Sessions";
import { Button, Card, Flex, Heading, Muted, P, Pill, Spinner } from "../ui/kit";
import { BusyButton, LastMessage, PButton } from "../ui/bits";
import { Cards } from "../ui/cards";
import { useTranscriptMatches, metaMatch, TabSearchBox, CardHits } from "./TabSearch";

const RESTORE_LABEL: Record<string, string> = { preparing: "Preparing…", creating: "Creating…", seeding: "Copying transcript…", starting: "Starting…" };
const running = (r: PrevSession) => !!r.restore && !["done", "failed"].includes(r.restore.phase);
const repoNames = (repos?: string) => String(repos || "").split(/[\s,]+/).filter(Boolean).map((u) => u.replace(/\.git$/, "").split("/").pop()).join(", ");

// Restore asks first; the question carries the optional resume prompt (blank = just bring it back).
// Never optimistic: the POST only starts a restore job (202); its phase is followed at
// GET api/records/:id/restore — the button label mirrors it — and the Sessions tab is shown only
// once Jarvis reports the new session's machine started.
// exclusive per record: the Previous card, its transcript page and a search hit all offer Restore
export const restore = (r: PrevSession) => exclusive("r:" + r.id, async () => {
  const again = (r.restored || []).length ? ` It was already restored ${ago(r.restored![r.restored!.length - 1].at)} — this starts another copy.` : "";
  const a = await askTextCheck({ title: `Restore “${r.title}”?`, detail: `Starts a new session with the same environment, repos, model and size, and resumes the conversation from the archived transcript. Repos are cloned fresh: uncommitted work of the old session is not part of the archive.${again}`, action: "Restore", input: { heading: "Restore session", ...RESUME_PROMPT },
    check: { ...API_PROXY_CHECK, on: r.apiProxy === "on" } });
  if (a === null) return;
  const prompt = a.text;
  const key = "r:" + r.id;
  pend(key, "Restoring…");
  try {
    await api("POST", "api/records/" + r.id + "/restore", { ...(prompt ? { prompt } : {}), apiProxy: a.checked });
    const until = Date.now() + 10 * 60 * 1000;
    let j: any = null, misses = 0;
    while (Date.now() < until) {
      await new Promise((res) => setTimeout(res, 1000));
      try { j = await api("GET", "api/records/" + r.id + "/restore"); misses = 0; }
      catch (e: any) { if (++misses >= 20) throw e; continue; }
      if (j.phase === "done" || j.phase === "failed" || j.phase === "none") break;
      pend(key, RESTORE_LABEL[j.phase] || "Restoring…");
    }
    if (!j || j.phase === "none") throw new Error("Jarvis lost track of the restore (it restarted?) — check the Sessions tab before trying again");
    if (j.phase === "failed") throw new Error(j.error || "restore failed");
    if (j.phase !== "done") throw new Error("the restore is taking more than 10 minutes — check the Sessions tab later");
    const sid = j.result?.sessionId;
    await refresh(false);
    toast(`Restored “${r.title}” — it resumes the conversation once it has booted.`, "ok");
    if (getStore().tab === "previous") setTab("sessions");
    settle((s) => { const m = s.sessions.find((x) => x.id === sid); return !!(m && m.state === "started" && m.status); });
  } catch (e: any) { failed(e); }
  finally { await loadPrevious(); pend(key, null); }
});

// Delete for good: the archive on the Storage Box (transcripts, artifacts, records, Discord export)
// and the index entry, then the search index re-crawls so it drops out of search too. Irreversible,
// so the dialog wants the title typed. Never optimistic: the card goes when the reloaded list lacks it.
export const purge = (r: PrevSession) => exclusive("r:" + r.id, async () => {
  const ok = await askText({ title: `Delete “${r.title}” permanently?`, danger: true, action: "Delete permanently",
    detail: `Deletes its archive on the Storage Box — transcript${r.transcripts === 1 ? "" : "s"}, artifacts, records and the Discord channel export — and takes it off this list and out of search. It can't be restored afterwards.${(r.restored || []).length ? " Sessions restored from it are separate and are not touched." : ""}`,
    input: { heading: "Delete permanently", label: "Type the session's title to confirm", placeholder: r.title, match: r.title } });
  if (ok === null) return;
  const key = "r:" + r.id;
  pend(key, "Deleting…");
  try {
    const j = await api<{ reindex: string }>("DELETE", "api/records/" + encodeURIComponent(r.id) + "?purge=1");
    toast(j.reindex === "started" ? `Deleted “${r.title}”. Search is re-indexing without it.` : `Deleted “${r.title}”. Search re-index did not start (${j.reindex}) — it drops out at the next crawl.`, "ok");
  } catch (e: any) { failed(e); }
  finally { await loadPrevious(); pend(key, null); }
});

export function Previous({ onTranscript, onOpenHit }: { onTranscript: (r: PrevSession) => void; onOpenHit: (h: SearchHit, terms: string[]) => void }) {
  const p = useStore((s) => s.previous);
  const pending = useStore((s) => s.pending);
  const [q, setQ] = useState("");
  // only text read from an archive: a restored session's archive is still its Previous card
  const tm = useTranscriptMatches(q, { archived: "1" });
  if (!p.loaded) return p.err ? <P size={3} color="gray" align="center" mt={8}>{`Previous sessions: ${p.err}`}</P> : <Flex justify="center" gap={2} align="center" mt={8}><Spinner /><P size={3} color="gray">Loading…</P></Flex>;
  if (!p.records.length) return <P size={3} color="gray" align="center" mt={8}>{"No previous sessions yet.\nA session you destroy is listed here and can be restored from its archived transcript."}</P>;
  // by title / settings, or by the archived conversation and records (a hit's dir = the record's archiveDir)
  const hitsFor = new Map(tm.groups.filter((g) => g.dir).map((g) => [g.dir!, g]));
  const shown = tm.needle ? p.records.filter((r) => hitsFor.has(r.archiveDir) || metaMatch(tm.needle, [r.title, r.repos, r.environment, r.machineName, r.model, r.last?.text])) : p.records;
  return (
    <>
      {!!p.err && <Muted>Could not refresh: {p.err}</Muted>}
      <TabSearchBox id="prev-q" placeholder="Search previous sessions" q={q} setQ={setQ} m={tm} />
      {!shown.length && !tm.busy && <P size={3} color="gray" align="center" mt={6} mb={6}>Nothing matches “{tm.needle}”.</P>}
      <Cards>
        {shown.map((r) => {
          const n = (r.restored || []).length;
          return (
            <Card key={r.id} data={{ record: r.id }}>
              <Flex justify="space-between" align="flex-start" gap={2} mb={1}>
                <Heading size={3} style={{ flex: 1 }}>{r.title}</Heading>
                {running(r) ? <Pill kind="wait" spin>{r.restore!.phase + "…"}</Pill> : n ? <Pill kind="ok">{"restored" + (n > 1 ? ` ×${n}` : "")}</Pill> : <Pill kind="dim">destroyed</Pill>}
              </Flex>
              <Muted>
                {`destroyed ${ago(r.destroyedAt)}${r.created ? ` · created ${new Date(r.created).toLocaleDateString()}` : ""}\n`}
                {[r.environment, r.model, r.size, r.permissionMode === "bypass" ? "skip permissions" : "", r.oneShot ? "was one-shot" : ""].filter(Boolean).join(" · ") + "\n"}
                {`${repoNames(r.repos) || "no repos"} · ${r.transcripts} transcript${r.transcripts === 1 ? "" : "s"}${r.artifacts === null ? " · artifacts archive" : r.artifacts ? ` · ${r.artifacts} artifact file${r.artifacts === 1 ? "" : "s"}` : ""}`}
              </Muted>
              {r.last && <LastMessage last={r.last} />}
              {!!tm.needle && <CardHits g={hitsFor.get(r.archiveDir)} terms={tm.terms} onOpen={onOpenHit} />}
              <Flex gap={2} pt={3} style={{ marginTop: "auto" }}>
                {/* a restore started elsewhere (another device, before a reload): nothing to tap until it ends */}
                {running(r) && !pending.has("r:" + r.id) ? <BusyButton label="Restoring…" /> : <PButton pkey={"r:" + r.id} onPress={() => restore(r)} label="Restore" />}
                <Button variant="soft" color="gray" onPress={() => onTranscript(r)}>Transcript</Button>
                <Button variant="soft" color="red" disabled={running(r) || pending.has("r:" + r.id)} onPress={() => purge(r)} style={{ marginLeft: "auto" }}>Delete</Button>
              </Flex>
            </Card>
          );
        })}
      </Cards>
    </>
  );
}
