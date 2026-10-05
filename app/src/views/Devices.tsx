// Devices tab: the shared devices agents drive (Deyao's iPhone, his Mac, the WeChat cloud phone) — who has each
// one, who is queued, the event log, and Take over / Hand back / Force return.
import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { api, ago, sessionTitle, type Lease } from "../lib/api";
import { useStore, getStore, pendUntil, ask, askText } from "../lib/store";
import { useTheme, radius } from "../theme";
import { Card, Flex, Heading, Muted, P, Pill } from "../ui/kit";
import { BusyButton } from "../ui/bits";
import { Button } from "../ui/kit";
import { Cards } from "../ui/cards";

const DEVICE_INFO: Record<string, string> = {
  iphone: "Your iPhone, driven from sessions over the Shenzhen relay. Agents take it one at a time for a task and give it back when done.",
  mac: "Your Mac (macbook-air-2), its screen driven from sessions over Tailscale (scripts/mac-control). Agents take it one at a time for a task and give it back when done.",
  "wechat-phone": "Aliyun cloud phone with the WeChat account (acp-g6pz42i5q7dtv7nqi). Permanent — never stopped or deleted.",
};

// Take over: Deyao uses the device himself — any agent holding it is stopped at once (its next action is
// refused), goes to the front of the queue, and is woken with his log when he hands it back.
// Force return is the escape hatch for a stuck holder; the next waiter is woken.
const leaseOf = (name: string) => ((getStore().state.leases || []) as Lease[]).find((x) => x.name === name);
export function forceReturnLease(name: string, holderTitle: string) {
  return (async () => {
    const ok = await ask({ title: `Take “${name}” back?`, detail: `${holderTitle} holds it now. Force return takes it back from them; the next queued session (if any) gets it and is woken.`, action: "Force return", danger: true });
    if (!ok) return;
    const since = leaseOf(name)?.holder?.since;
    await pendUntil("lease:" + name, "Taking back…", () => api("POST", "api/leases/" + encodeURIComponent(name) + "/force-return"),
      (s) => { const l = ((s.leases || []) as Lease[]).find((x) => x.name === name); return !l || !l.holder || l.holder.since !== since; });
  })();
}
export function takeOverLease(name: string, holderTitle: string | null) {
  return (async () => {
    const note = await askText({
      title: `Take over “${name}”?`,
      detail: holderTitle
        ? `${holderTitle} is using it. It is stopped now (every device action is refused), goes first in line, and is woken with your log when you hand the device back.`
        : "No agent can use it until you hand it back.",
      action: "Take over",
      input: { heading: "Note for the agents (optional)", label: "Note", placeholder: "e.g. answering a call", max: 1000 },
    });
    if (note === null) return;
    await pendUntil("lease:" + name, "Taking over…", () => api("POST", "api/leases/" + encodeURIComponent(name) + "/take-over", { note }),
      (s) => !!((s.leases || []) as Lease[]).find((x) => x.name === name)?.holder?.human);
  })();
}
export function handBackLease(name: string, nextTitle: string | null) {
  return (async () => {
    const note = await askText({
      title: `Hand “${name}” back?`,
      detail: nextTitle ? `${nextTitle} gets it next and is woken with your log and note, and continues from the state you left it in.` : "Nobody is waiting; it becomes free.",
      action: "Hand back",
      input: { heading: "What did you do / what state is it in? (optional)", label: "Note", placeholder: "e.g. left it on the home screen, logged out of X", max: 1000 },
    });
    if (note === null) return;
    await pendUntil("lease:" + name, "Handing back…", () => api("POST", "api/leases/" + encodeURIComponent(name) + "/hand-back", { note }),
      (s) => !((s.leases || []) as Lease[]).find((x) => x.name === name)?.holder?.human);
  })();
}
const EVENT_TEXT: Record<string, string> = {
  granted: "got it", promoted: "got it (was waiting)", returned: "returned it", "force-returned": "force-returned",
  expired: "lost it (stopped renewing)", "taken-over": "You took it over", "handed-back": "You handed it back",
};
// One labelled person on a device card: who (bold), the one-line purpose, the agent's own multi-line
// description, and a small meta line. The holder and each waiter get the same block.
const SubLbl = ({ children }: { children: ReactNode }) => <P size={1} weight="bold" color="gray" upper mt={3} mb={1}>{children}</P>;
function Entry({ who, badge, purpose, description, meta }: { who: string; badge?: ReactNode; purpose?: string; description?: string; meta: string }) {
  const t = useTheme();
  return (
    <View style={{ marginBottom: 8, padding: 8, backgroundColor: t.gray.a[2], borderRadius: radius[2] }}>
      <Flex gap={2} align="flex-start" justify="space-between"><P size={2} weight="bold" style={{ flex: 1 }}>{who}</P>{badge}</Flex>
      {!!purpose && <P size={2} mt={1}>{purpose}</P>}
      {!!description && <P size={2} color="gray" mt={1}>{description}</P>}
      <P size={1} color="gray" mt={1}>{meta}</P>
    </View>
  );
}
// the event log, folded away until tapped
function Log({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ marginTop: 6 }}>
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button"><P size={1} color="gray">{(open ? "▾ " : "▸ ") + "Log"}</P></Pressable>
      {open && lines.map((l, i) => <Muted key={i}>{l}</Muted>)}
    </View>
  );
}
const iso = (ms: number) => new Date(ms).toISOString();
const updated = (at: number, start: number) => at && at - start > 30000 ? " · updated " + ago(iso(at)) : "";
export function Devices() {
  const ls = useStore((s) => s.state.leases) || [];
  const sessions = useStore((s) => s.state.sessions) || [];
  const pending = useStore((s) => s.pending);
  const titleOf = (sid: string) => { const m = sessions.find((x) => x.id === sid); return m ? sessionTitle(m) : sid; };
  return (
    <View nativeID="leases">
      <Muted>Agents share these devices one at a time; the others wait in line and are woken in turn. Take over to use one yourself — agents are blocked until you hand it back, then continue from the state you left it in.</Muted>
      <Cards mt={12}>
        {ls.map((l) => {
          const busy = pending.get("lease:" + l.name);
          const h = l.holder;
          const next = l.queue[0] ? titleOf(l.queue[0].sid) : null;
          return (
            <Card key={l.name} data={{ lease: l.name }}>
              <Flex justify="space-between" align="flex-start" gap={2} mb={1}><Heading size={3} style={{ flex: 1 }}>{l.name}</Heading>{h ? (h.human ? <Pill kind="ok">you have it</Pill> : <Pill kind="wait">in use</Pill>) : <Pill kind="ok">free</Pill>}</Flex>
              {!!DEVICE_INFO[l.name] && <P size={1} color="gray">{DEVICE_INFO[l.name]}</P>}
              <SubLbl>Using it</SubLbl>
              {!h && <Muted>Nobody — free.</Muted>}
              {h && h.human && <Entry who="You" purpose={h.note || undefined} meta={`Taken over ${ago(iso(h.since))} · agents are blocked until you hand it back`} />}
              {h && !h.human && <Entry who={titleOf(h.sid)} purpose={h.purpose} description={h.description}
                meta={`Since ${ago(iso(h.since))}${updated(h.describedAt, h.since)} · lapses in ~${Math.max(1, Math.round((h.expiresInSeconds || 0) / 60))} min unless renewed`} />}
              <SubLbl>{"Waiting" + (l.queue.length ? ` (${l.queue.length})` : "")}</SubLbl>
              {!l.queue.length && <Muted>Nobody waiting.</Muted>}
              {l.queue.map((w) => <Entry key={w.sid} who={`${w.position}. ${titleOf(w.sid)}`} badge={w.interrupted ? <Pill kind="dim">interrupted</Pill> : undefined}
                purpose={w.purpose} description={w.description} meta={`Waiting since ${ago(iso(w.enqueuedAt))}${updated(w.describedAt, w.enqueuedAt)}`} />)}
              {l.log.length > 0 && <Log lines={l.log.slice().reverse().slice(0, 10).map((e) => `${ago(iso(e.at))} · ${e.sid && e.sid !== "deyao" ? titleOf(e.sid) + " " : ""}${EVENT_TEXT[e.kind] || e.kind}${e.note ? " — " + e.note : ""}`)} />}
              <Flex gap={2} wrap pt={2} style={{ marginTop: "auto" }}>
                {busy ? <BusyButton label={busy} variant={h && h.human ? "solid" : "soft"} />
                  : h && h.human ? <Button onPress={() => handBackLease(l.name, next)}>Hand back</Button>
                  : <Button variant="soft" onPress={() => takeOverLease(l.name, h ? titleOf(h.sid) : null)}>Take over</Button>}
                {h && !h.human && <Button variant="soft" color="red" disabled={!!busy} onPress={() => forceReturnLease(l.name, titleOf(h.sid))}>Force return</Button>}
              </Flex>
            </Card>
          );
        })}
      </Cards>
    </View>
  );
}
