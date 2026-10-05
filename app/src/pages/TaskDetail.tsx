// One task instance: its values, Run / Edit / Delete, its daily schedules, and its runs (newest
// first, the last 20 kept) — tap a run for its log.
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { api, fromNow, RUN_ACTIVE, type TaskRun } from "../lib/api";
import { useStore, ask, loadTasks, pendTasks } from "../lib/store";
import { useTheme } from "../theme";
import { Button, Card, Flex, Lbl, Muted, P, Spinner } from "../ui/kit";
import { PButton } from "../ui/bits";
import { Page, closePage, openPage } from "../ui/page";
import { RunPill, runWhen, paramSummary, runInstance } from "../views/Tasks";
import { scheduleText } from "../views/Schedules";

export function TaskDetail({ id }: { id: string }) {
  const t = useTheme();
  const data = useStore((s) => s.tasks.data);
  const inst = data.instances.find((i) => i.id === id);
  const tmpl = inst && data.templates.find((x) => x.name === inst.template);
  const schedules = data.schedules.filter((s) => s.instance === id);
  const [runs, setRuns] = useState<TaskRun[] | null>(null), [err, setErr] = useState("");
  const lastName = inst?.lastRun?.name, active = runs ? runs.some((r) => RUN_ACTIVE(r.phase)) : false;
  // the run list follows api/tasks (a new run, a phase change) and polls itself while one is active
  useEffect(() => {
    let live = true, timer: any;
    const load = async () => {
      try { const j = await api<{ runs: TaskRun[] }>("GET", `api/tasks/instances/${id}/runs`); if (!live) return; setRuns(j.runs); setErr("");
        if (j.runs.some((r) => RUN_ACTIVE(r.phase))) timer = setTimeout(load, 2000); }
      catch (e: any) { if (live) setErr(e.message); }
    };
    load();
    return () => { live = false; clearTimeout(timer); };
  }, [id, lastName, inst?.lastRun?.phase]);
  useEffect(() => { loadTasks(); }, [id]);
  if (!inst) return <Page title="Task"><Muted mt={3}>This task instance no longer exists.</Muted></Page>;
  const del = async () => {
    if (!(await ask({ title: `Delete “${inst.name}”?`, detail: `Its ${schedules.length ? schedules.length + " schedule(s) and " : ""}run history go with it. The template stays.`, action: "Delete", danger: true }))) return;
    await pendTasks("task-del:" + id, "Deleting…", () => api("DELETE", "api/tasks/instances/" + id), (d) => !d.instances.some((i) => i.id === id));
    closePage();
  };
  return (
    <Page title={inst.name} right={active || (inst.lastRun && RUN_ACTIVE(inst.lastRun.phase)) ? <Button disabled>Running…</Button> : <PButton pkey={"task:" + id} label="Run" onPress={() => runInstance(id)} id="td-run" />}>
      <Muted mt={2}>{tmpl ? tmpl.title : `${inst.template} (template missing)`} · created {new Date(inst.createdAt).toLocaleDateString()}</Muted>
      {!!paramSummary(inst, tmpl) && <Card mt={3} size={1} variant="surface"><P size={2} selectable>{paramSummary(inst, tmpl)}</P></Card>}
      <Flex gap={2} mt={3} wrap>
        <Button variant="soft" disabled={!tmpl} onPress={() => openPage("task-edit", { id })} id="td-edit">Edit</Button>
        <Button variant="soft" onPress={() => openPage("schedule", { instance: id })} id="td-schedule">Schedule daily…</Button>
        <PButton pkey={"task-del:" + id} variant="soft" color="red" label="Delete" onPress={del} />
      </Flex>
      {schedules.length > 0 && <>
        <Lbl>Schedules</Lbl>
        {schedules.map((s) => (
          <Pressable key={s.id} onPress={() => openPage("schedule", { id: s.id })} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: t.gray.a[4] }}>
            <P size={2}>{scheduleText(s)}</P>
            <Muted>{s.enabled && s.nextAt ? "next " + fromNow(new Date(s.nextAt)) : "off"}</Muted>
          </Pressable>))}
      </>}
      <Lbl>Runs</Lbl>
      {err ? <P size={2} color="red">{err}</P>
        : !runs ? <Flex gap={2} align="center"><Spinner /><Muted>Loading runs…</Muted></Flex>
        : !runs.length ? <Muted>Not run yet.</Muted>
        : <View nativeID="td-runs">{runs.map((r) => (
          <Pressable key={r.name} {...({ dataSet: { run: r.name } } as any)} onPress={() => openPage("task-run", { name: r.name, title: inst.name })}
            style={({ hovered }: any) => ({ paddingVertical: 10, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: t.gray.a[4], backgroundColor: hovered ? t.gray.a[2] : "transparent" })}>
            <Flex gap={2} align="center" wrap>
              <RunPill run={r} />
              <P size={2}>{r.trigger === "schedule" ? "Scheduled" : "Manual"}</P>
              <Muted>{runWhen(r)}{r.exitCode != null && r.phase !== "succeeded" ? ` · exit ${r.exitCode}` : ""}</Muted>
            </Flex>
          </Pressable>))}</View>}
    </Page>
  );
}
