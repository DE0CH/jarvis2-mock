// One run: its state, why it failed, and the pod's log (the last 256 KB), refreshed every 2 s
// while it runs. Stop suspends the Job (its pod is killed; the run stays in the history).
import { useEffect, useState } from "react";
import { api, ago, RUN_ACTIVE, type TaskRun as Run } from "../lib/api";
import { ask, loadTasks } from "../lib/store";
import { useTheme, radius } from "../theme";
import { Button, Callout, Flex, Muted, P, Spinner, Text, mono } from "../ui/kit";
import { Page } from "../ui/page";
import { RunPill } from "../views/Tasks";
import { View } from "react-native";

export function TaskRun({ name, title }: { name: string; title: string }) {
  const t = useTheme();
  const [run, setRun] = useState<Run | null>(null), [log, setLog] = useState(""), [err, setErr] = useState(""), [stopping, setStopping] = useState(false);
  useEffect(() => {
    let live = true, timer: any;
    const load = async () => {
      try { const j = await api<{ run: Run; log: string }>("GET", "api/tasks/runs/" + encodeURIComponent(name)); if (!live) return; setRun(j.run); setLog(j.log); setErr("");
        if (RUN_ACTIVE(j.run.phase)) timer = setTimeout(load, 2000); else loadTasks(); }
      catch (e: any) { if (live) { setErr(e.message); timer = setTimeout(load, 5000); } }
    };
    load();
    return () => { live = false; clearTimeout(timer); };
  }, [name]);
  const stop = async () => {
    if (!(await ask({ title: "Stop this run?", detail: "Its pod is killed now; the run stays in the history as stopped.", action: "Stop", danger: true }))) return;
    setStopping(true);
    try { await api("POST", `api/tasks/runs/${encodeURIComponent(name)}/stop`); for (let i = 0; i < 15; i++) { const j = await api<{ run: Run; log: string }>("GET", "api/tasks/runs/" + encodeURIComponent(name)); setRun(j.run); setLog(j.log); if (!RUN_ACTIVE(j.run.phase)) break; await new Promise((r) => setTimeout(r, 1000)); } }
    catch (e: any) { setErr(e.message); }
    setStopping(false);
  };
  return (
    <Page title={title} right={run && RUN_ACTIVE(run.phase) ? <Button color="red" variant="soft" disabled={stopping} onPress={stop} id="tr-stop">{stopping ? "Stopping…" : "Stop"}</Button> : undefined}>
      {!run ? (err ? <P size={2} color="red" mt={3}>{err}</P> : <Flex gap={2} align="center" mt={4}><Spinner /><Muted>Loading the run…</Muted></Flex>) : <>
        <Flex gap={2} align="center" mt={2} wrap>
          <RunPill run={run} />
          <Muted>{run.trigger === "schedule" ? `Scheduled (${run.slot ? new Date(run.slot).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""})` : "Manual"}</Muted>
        </Flex>
        <Muted mt={1}>{run.startedAt ? `Started ${ago(run.startedAt)}` : run.createdAt ? `Created ${ago(run.createdAt)}` : ""}{run.finishedAt ? ` · finished ${ago(run.finishedAt)}` : ""}{run.exitCode != null ? ` · exit code ${run.exitCode}` : ""}</Muted>
        <Muted>{run.name}</Muted>
        {!!run.reason && <Callout color="red" mt={3}>{run.reason}</Callout>}
        {!!run.waiting && <Callout color="amber" mt={3}>{"Waiting: " + run.waiting}</Callout>}
        {!!err && <P size={2} color="red" mt={2}>{err}</P>}
        <View nativeID="tr-log" style={{ marginTop: 12, padding: 12, borderRadius: radius[3], backgroundColor: t.gray.a[2], borderWidth: 1, borderColor: t.gray.a[5] }}>
          {log ? <Text selectable style={{ fontFamily: mono, fontSize: 12.5, lineHeight: 18, color: t.gray[12] }}>{log}</Text>
            : <Muted>{RUN_ACTIVE(run.phase) ? "No output yet…" : "No output."}</Muted>}
        </View>
      </>}
    </Page>
  );
}
