import { useLocalSearchParams } from "expo-router";
import { SearchContext, type ContextAction } from "../pages/SearchContext";
import { payloadOf } from "../ui/page";
import { Gone } from "../ui/gone";
import { useStore, setTab } from "../lib/store";
import { wakeSession } from "../views/Sessions";
import { restore } from "../views/Previous";
import type { SearchHit } from "../lib/api";

// how the session a search hit belongs to comes back: Restore when its archive is in the Previous
// list, Start when it is paused NOW (the index may be older than the list); a running one needs
// nothing. A hook, so the button follows the list as it loads and changes.
function useHitAction(h: SearchHit | null): ContextAction {
  const sessions = useStore((s) => s.state.sessions), records = useStore((s) => s.previous.records);
  if (!h) return null;
  if (h.machineId && sessions.some((m) => m.id === h.machineId && (m.state === "stopped" || m.state === "suspended"))) return { label: "Start", run: () => { setTab("sessions"); wakeSession(h.machineId!); } };
  const rec = h.dir ? records.find((r) => r.archiveDir === h.dir) : null;
  return rec ? { label: "Restore", run: () => restore(rec) } : null;
}
export default function ContextRoute() {
  const { k } = useLocalSearchParams();
  const p = payloadOf<{ hit: SearchHit; terms: string[] }>(k);
  const action = useHitAction(p?.hit || null);
  return p ? <SearchContext hit={p.hit} terms={p.terms} action={action} /> : <Gone />;
}
