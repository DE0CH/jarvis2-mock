// Tasks tab: the instances (a template filled in with data — tap Run to execute it as a k8s Job on
// the box) and the templates they come from (selfhost/tasks/<name>/ in git, written by Claude).
// Schedules have their own tab (views/Schedules.tsx).
import { Pressable, View } from "react-native";
import { api, ago, RUN_ACTIVE, type TaskInstance, type TaskRun, type TaskTemplate, type TasksOverview } from "../lib/api";
import { useStore, pendTasks } from "../lib/store";
import { Button, Callout, Card, Flex, Heading, Lbl, Muted, P, Pill, Spinner } from "../ui/kit";
import { PButton } from "../ui/bits";
import { Cards } from "../ui/cards";
import { openPage } from "../ui/page";

const PHASE: Record<TaskRun["phase"], ["ok" | "dim" | "wait" | "bad" | "info", string]> = {
  starting: ["wait", "starting"], running: ["info", "running"], succeeded: ["ok", "succeeded"], failed: ["bad", "failed"], timedout: ["bad", "timed out"], stopped: ["dim", "stopped"],
};
export function RunPill({ run }: { run: TaskRun }) {
  const [kind, label] = PHASE[run.phase] || ["dim", run.phase];
  return <Pill kind={kind} spin={RUN_ACTIVE(run.phase)}>{label}</Pill>;
}
export const runWhen = (r: TaskRun) => (r.finishedAt ? "finished " + ago(r.finishedAt) : r.startedAt ? "started " + ago(r.startedAt) : r.createdAt ? "created " + ago(r.createdAt) : "");
export function paramSummary(inst: TaskInstance, t?: TaskTemplate) {
  return (t ? t.fields : Object.keys(inst.params).map((name) => ({ name, label: name, type: "text" })))
    .map((f) => {
      if ((inst.hidden || []).includes(f.name)) return (inst.hiddenSet || []).includes(f.name) ? `${f.label}: hidden` : null;
      const v = inst.params[f.name]; return v === "" || v == null || (Array.isArray(v) && !v.length) ? null : `${f.label}: ${f.type === "checkbox" ? (v ? "yes" : "no") : Array.isArray(v) ? v.join(", ") : String(v)}`;
    })
    .filter(Boolean).join(" · ");
}
// Run now; the button stays "Starting…" until api/tasks lists the new run as this instance's last
export function runInstance(id: string) {
  let name = "";
  return pendTasks("task:" + id, "Starting…", async () => { name = (await api("POST", `api/tasks/instances/${id}/run`)).name; },
    (d: TasksOverview) => d.instances.some((i) => i.id === id && i.lastRun?.name === name));
}

function InstanceCard({ inst, t }: { inst: TaskInstance; t?: TaskTemplate }) {
  const busy = !!inst.lastRun && RUN_ACTIVE(inst.lastRun.phase);
  return (
    <Card data={{ task: inst.id }}>
      <Pressable accessibilityRole="button" onPress={() => openPage("task", { id: inst.id })} style={({ hovered }: any) => ({ opacity: hovered ? 0.85 : 1 })}>
        <Flex gap={2} align="center" wrap>
          <Heading size={3} style={{ flexShrink: 1 }}>{inst.name}</Heading>
          {inst.lastRun && <RunPill run={inst.lastRun} />}
        </Flex>
        <Muted>{t ? t.title : `${inst.template} (template missing)`}{inst.schedules ? ` · ${inst.schedules} schedule${inst.schedules > 1 ? "s" : ""}` : ""}</Muted>
        {!!paramSummary(inst, t) && <P size={2} mt={1} lines={2}>{paramSummary(inst, t)}</P>}
        <P size={1} color="gray" mt={1}>{inst.lastRun ? `Last run ${runWhen(inst.lastRun)}${inst.lastRun.trigger === "schedule" ? " (scheduled)" : ""}` : "Never run"}</P>
      </Pressable>
      <Flex gap={2} style={{ marginTop: "auto", paddingTop: 12 }}>
        {busy ? <Button variant="soft" disabled>Running…</Button> : <PButton pkey={"task:" + inst.id} label="Run" onPress={() => runInstance(inst.id)} id={"run-" + inst.id} />}
        <Button variant="soft" color="gray" onPress={() => openPage("task", { id: inst.id })}>Open</Button>
      </Flex>
    </Card>
  );
}

function TemplateCard({ t }: { t: TaskTemplate }) {
  return (
    <Card variant="surface" data={{ template: t.name }}>
      <Heading size={3}>{t.title}</Heading>
      <Muted>{t.name}{t.stores && t.stores.length ? ` · secrets: ${t.stores.join(", ")}` : ""}</Muted>
      {t.error ? <P size={2} color="red" mt={1}>Broken task.json: {t.error}</P>
        : <>
          {!!t.description && <P size={2} mt={1}>{t.description}</P>}
          {!!t.fields.length && <P size={1} color="gray" mt={1}>Fields: {t.fields.map((f) => f.label + (f.required ? " *" : "")).join(", ")}</P>}
        </>}
      <Flex gap={2} style={{ marginTop: "auto", paddingTop: 12 }}>
        <Button variant="soft" disabled={!!t.error} onPress={() => openPage("task-edit", { template: t.name })} id={"new-" + t.name}>New instance</Button>
      </Flex>
    </Card>
  );
}

export function Tasks() {
  const ts = useStore((s) => s.tasks);
  const { templates, instances, taskImage } = ts.data;
  const tmpl = (n: string) => templates.find((x) => x.name === n);
  if (!ts.loaded) return ts.err ? <Callout color="red">{"Could not load tasks: " + ts.err}</Callout>
    : <Flex gap={2} align="center" justify="center" mt={6}><Spinner /><P size={3} color="gray">Loading tasks…</P></Flex>;
  return (
    <View>
      {!!ts.err && <Callout color="red" mb={3}>{"Could not refresh: " + ts.err}</Callout>}
      {!taskImage && <Callout color="amber" mb={3}>No task image pinned yet — runs need the task-image workflow to have built one (templates that name their own image still run).</Callout>}
      <Lbl mt={0}>Instances</Lbl>
      {instances.length ? <Cards>{instances.map((i) => <InstanceCard key={i.id} inst={i} t={tmpl(i.template)} />)}</Cards>
        : <Muted>No instances yet — pick a template below and fill it in.</Muted>}
      <Lbl mt={6}>Templates</Lbl>
      {templates.length ? <Cards>{templates.map((t) => <TemplateCard key={t.name} t={t} />)}</Cards>
        : <Muted>No templates in selfhost/tasks yet. Ask Claude to write one.</Muted>}
    </View>
  );
}
