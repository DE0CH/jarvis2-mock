// The list: a top bar (the tab's name on a wide screen, where the tabs are the sidebar), the banners,
// the tabs (narrow screens), and the tab's view. Pages open on top of it (ui/page.tsx) and it stays
// mounted underneath, so its scroll position is kept. No pull-to-refresh: the ↻ button refreshes,
// and coming back to the foreground refreshes by itself.
import type { ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api, ago, sessionTitle, type PrevSession, type Session } from "../lib/api";
import { useStore, setTab, refresh, pend, failed, exclusive, TABS, type Tab } from "../lib/store";
import { useTheme } from "../theme";
import { Button, Callout, Heading, IconButton, Spinner, Tabs } from "../ui/kit";
import { TopBar, openPage } from "../ui/page";
import { useWide } from "../ui/overlays";
import { Sessions, wakeSession } from "../views/Sessions";
import { Previous, restore } from "../views/Previous";
import { Search } from "../views/Search";
import { Devices } from "../views/Devices";
import { Envs } from "../views/Envs";
import { Repos } from "../views/Repos";
import { Content, addContentStore } from "../views/Content";
import { Settings } from "../views/Settings";
import { Tasks } from "../views/Tasks";
import { Schedules } from "../views/Schedules";
import type { TranscriptSpec } from "../pages/Transcript";

// the two conversations that can be read while they are not running, and how each comes back
const prevTranscript = (r: PrevSession): TranscriptSpec => ({ title: r.title, note: `Destroyed ${ago(r.destroyedAt)}`, path: "api/records/" + r.id + "/tail", action: { label: "Restore", run: () => restore(r) } });
const pausedTranscript = (m: Session): TranscriptSpec => ({ title: sessionTitle(m), note: "Paused", path: "api/sessions/" + m.id + "/tail", action: { label: "Start", run: () => wakeSession(m.id) } });

function Banners() {
  const st = useStore((s) => s.state);
  const B = ({ color, children }: { color: "red" | "amber"; children: ReactNode }) => <Callout color={color} mb={3}>{children as string}</Callout>;
  return (
    <View nativeID="banners">
      {st.hasCreds === false ? <B color="red">No Claude credentials — sessions can't authenticate. Re-login from Settings.</B>
        : (st.creds || {}).stale ? <B color="red">Claude login expired and the token refresh was rejected — new sessions can't sign in. Re-login from Settings.</B> : null}
      {!!st.version && !st.sessionImage && <B color="amber">No session image pinned yet — run the session-image workflow on GitHub (see Settings).</B>}
      {!!st.loadError && <B color="red">{"Can't reach Jarvis: " + st.loadError}</B>}
      {!!st.flyError && <B color="red">{"Fly: " + st.flyError}</B>}
    </View>
  );
}

let reloginAt = 0;
const relogin = () => exclusive("auth", async () => {
  pend("auth", "Starting…");
  const at = ++reloginAt;
  try { const { url } = await api("POST", "api/auth/start"); if (at === reloginAt) openPage("relogin", { url }); }
  catch (e: any) { failed(e, "Could not start login: "); }
  finally { pend("auth", null); }
});

export default function Dashboard() {
  const t = useTheme(), ins = useSafeAreaInsets(), wide = useWide();
  const tab = useStore((s) => s.tab);
  const refreshing = useStore((s) => s.refreshing);
  return (
    <View style={{ flex: 1, backgroundColor: t.background }}>
      <TopBar max={wide ? 1320 : 820}>
        <Heading size={4} lines={1} style={{ flex: 1, minWidth: 0 }}>{wide ? TABS.find(([k]) => k === tab)![1] : "Jarvis"}</Heading>
        <IconButton id="refreshBtn" variant="soft" color="gray" label="Refresh" onPress={() => refresh(true)}>{refreshing ? <Spinner /> : "↻"}</IconButton>
        {tab === "sessions" && <Button id="newBtn" onPress={() => openPage("new")}>+ New session</Button>}
        {tab === "content" && <Button id="newContentBtn" onPress={() => addContentStore()}>+ New store</Button>}
        {tab === "schedules" && <Button id="newScheduleBtn" onPress={() => openPage("schedule", {})}>+ New schedule</Button>}
      </TopBar>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 24 + ins.bottom }}>
        <View style={{ width: "100%", maxWidth: wide ? 1320 : 820, alignSelf: "center", paddingHorizontal: wide ? 32 : 16, paddingTop: 16 }}>
          <Banners />
          {!wide && <Tabs value={tab} onChange={(v) => setTab(v as Tab)} items={TABS} />}
          <View nativeID={"view-" + tab}>
            {tab === "sessions" && <Sessions onTerminal={(id, title) => openPage("terminal", { id, title })} onTranscript={(m) => openPage("transcript", pausedTranscript(m))} onRemote={(m) => openPage("remote", { id: m.id, title: sessionTitle(m) })} onOpenHit={(hit, terms) => openPage("context", { hit, terms })} />}
            {tab === "search" && <Search onOpen={(hit, terms) => openPage("context", { hit, terms })} />}
            {tab === "previous" && <Previous onTranscript={(r) => openPage("transcript", prevTranscript(r))} onOpenHit={(hit, terms) => openPage("context", { hit, terms })} />}
            {tab === "tasks" && <Tasks />}
            {tab === "schedules" && <Schedules />}
            {tab === "devices" && <Devices />}
            {tab === "envs" && <Envs onEdit={(name) => openPage("env", { name })} />}
            {tab === "content" && <Content />}
            {tab === "repos" && <Repos />}
            {tab === "settings" && <Settings onRelogin={relogin} />}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}
