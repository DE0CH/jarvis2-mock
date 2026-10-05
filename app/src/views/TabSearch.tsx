// The search box on the Sessions and Previous tabs: a card matches when its title / settings contain
// the text (instantly, on the device) OR its conversation does — a keyword lookup in the transcript
// index (api/search, the same index as the Search tab), limited to that tab's sessions. Keyword, not
// hybrid: the semantic leg ranks every session as "somewhat similar", which a filter can't use. A
// transcript match shows its best passage on the card; tapping it opens the conversation around it,
// like a Search tab hit.
import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { api, type SearchGroup, type SearchHit, type SearchResult } from "../lib/api";
import { Flex, Muted, P, Spinner, TextField } from "../ui/kit";
import { Hit } from "./Search";

export type TabMatches = { needle: string; groups: SearchGroup[]; terms: string[]; busy: boolean; err: string };

// params: the tab's slice of the index (`state=live,paused`, or `archived=1`)
export function useTranscriptMatches(q: string, params: Record<string, string>): TabMatches {
  const needle = q.trim();
  const [got, setGot] = useState<{ q: string; groups: SearchGroup[]; terms: string[]; err: string } | null>(null);
  const seq = useRef(0);
  const key = new URLSearchParams(params).toString();
  useEffect(() => {
    const n = ++seq.current;
    if (needle.length < 2) { setGot(null); return; }
    // typed, not submitted: wait for a pause in the typing; the latest query wins
    const t = setTimeout(async () => {
      const p = new URLSearchParams({ ...params, q: needle, mode: "keyword", rerank: "0", group: "1", limit: "50" });
      try { const r = await api<SearchResult>("GET", "api/search?" + p); if (n === seq.current) setGot({ q: needle, groups: r.sessions || [], terms: r.terms || [], err: "" }); }
      catch (e: any) { if (n === seq.current) setGot({ q: needle, groups: [], terms: [], err: e.message }); }
    }, 350);
    return () => clearTimeout(t);
  }, [needle, key]);
  const fresh = !!got && got.q === needle;
  return { needle, groups: fresh ? got!.groups : [], terms: fresh ? got!.terms : [], busy: needle.length >= 2 && !fresh, err: fresh ? got!.err : "" };
}

export const metaMatch = (needle: string, values: unknown[]) => { const n = needle.toLowerCase(); return values.some((v) => String(v || "").toLowerCase().includes(n)); };

export function TabSearchBox({ id, placeholder, q, setQ, m }: { id: string; placeholder: string; q: string; setQ: (q: string) => void; m: TabMatches }) {
  return (
    <View style={{ marginBottom: m.busy || m.err ? 4 : 12 }}>
      <TextField id={id} size={3} placeholder={placeholder} returnKeyType="search" autoComplete="off" autoCorrect={false} value={q} onChangeText={setQ} />
      {m.busy && <Flex gap={2} align="center" mt={1} mb={2}><Spinner /><P size={1} color="gray">Searching the transcripts…</P></Flex>}
      {!!m.err && <P size={1} color="red" mt={1} mb={2}>Transcript search: {m.err}</P>}
    </View>
  );
}

// the passage(s) that made a card match
export function CardHits({ g, terms, onOpen }: { g?: SearchGroup; terms: string[]; onOpen: (h: SearchHit, terms: string[]) => void }) {
  if (!g) return null;
  return (
    <View style={{ gap: 12, marginTop: 12 }}>
      {g.hits.slice(0, 2).map((h) => <Hit key={h.id} h={h} terms={terms} onOpen={(x) => onOpen(x, terms)} bare />)}
      {g.count > 2 && <Muted>{g.count} matches in this conversation</Muted>}
    </View>
  );
}
