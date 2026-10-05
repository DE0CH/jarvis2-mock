// New / edit a task instance: a name plus the template's fields, drawn from its task.json
// (text, textarea, number, select, multiselect, checkbox). Saved values go to git with the instance.
// Any field can be HIDDEN (its Hide button): from then on its value is never shown — not here, not
// by the API — only replaced or cleared; Jarvis keeps it in an encrypted Secret, out of the repo
// every session has checked out.
import { useState } from "react";
import { api, type TaskField } from "../lib/api";
import { useStore, loadTasks, toast, ask } from "../lib/store";
import { Button, CheckboxCards, Flex, Lbl, Muted, P, RadioCards, Spinner, Switch, TextArea, TextField } from "../ui/kit";
import { BtnLabel, useBusy } from "../ui/bits";
import { Page, closePage, openPage } from "../ui/page";

export type TaskEditSpec = { template?: string; id?: string };
const initial = (f: TaskField, v: unknown): any => {
  const x = v === undefined ? f.default : v;
  if (f.type === "checkbox") return !!x;
  if (f.type === "multiselect") return Array.isArray(x) ? x.map(String) : [];
  return x == null ? "" : String(x);
};

export function FieldInput({ f, value, onChange, secure, placeholder }: { f: TaskField; value: any; onChange: (v: any) => void; secure?: boolean; placeholder?: string }) {
  const opts = (f.options || []).map((o) => ({ value: o.value, title: o.label, sub: o.sub }));
  const ph = placeholder || f.placeholder;
  // a hidden field's replacement is typed masked (a textarea becomes a one-line masked field)
  if (secure && (f.type === "text" || f.type === "textarea" || f.type === "number" || !f.type))
    return <TextField id={"tf-" + f.name} secureTextEntry autoComplete="off" autoCorrect={false} placeholder={ph} value={value} onChangeText={onChange} />;
  switch (f.type) {
    case "textarea": return <TextArea id={"tf-" + f.name} rows={4} placeholder={ph} value={value} onChangeText={onChange} />;
    case "number": return <TextField id={"tf-" + f.name} keyboardType="numeric" placeholder={ph} value={value} onChangeText={onChange} />;
    case "select": return opts.length ? <RadioCards id={"tf-" + f.name} value={value} onChange={onChange} options={opts} /> : <Muted>No options available.</Muted>;
    case "multiselect": return opts.length ? <CheckboxCards id={"tf-" + f.name} value={value} onChange={onChange} options={opts} /> : <Muted>No options available.</Muted>;
    case "checkbox": return <Switch id={"tf-" + f.name} on={!!value} onChange={onChange} label={value ? "Yes" : "No"} />;
    default: return <TextField id={"tf-" + f.name} autoComplete="off" autoCorrect={false} placeholder={ph} value={value} onChangeText={onChange} />;
  }
}

export function TaskEdit({ spec }: { spec: TaskEditSpec }) {
  const data = useStore((s) => s.tasks.data);
  const inst = spec.id ? data.instances.find((i) => i.id === spec.id) : undefined;
  const t = data.templates.find((x) => x.name === (inst ? inst.template : spec.template));
  const [name, setName] = useState(inst ? inst.name : t ? t.title : "");
  const [vals, setVals] = useState<Record<string, any>>(() => Object.fromEntries((t?.fields || []).map((f) => [f.name, (inst?.hidden || []).includes(f.name) ? initial(f, "") : initial(f, inst?.params[f.name])])));
  // hidden: already hidden on the server (inst.hidden) + hidden in this edit (newHide, sent as `hide`);
  // replaced: hidden fields whose value the user typed or cleared here (only those are sent)
  const wasHidden = new Set(inst?.hidden || []);
  const [newHide, setNewHide] = useState<string[]>([]);
  const [replaced, setReplaced] = useState<Record<string, boolean>>({});
  const isHidden = (n: string) => wasHidden.has(n) || newHide.includes(n);
  const hide = async (f: TaskField) => {
    if (!(await ask({ title: `Hide “${f.label}”?`, detail: "Its value will never be shown again — not here, not by the API, not in run logs. You can still replace or clear it.", action: "Hide" }))) return;
    setNewHide((x) => [...x, f.name]);
  };
  const [busy, run, guard] = useBusy();
  const [err, setErr] = useState("");
  if (!t) return <Page title="Task"><P size={2} color="red" mt={3}>{spec.id && !inst ? "This instance no longer exists." : `Template “${inst?.template || spec.template}” is not in selfhost/tasks.`}</P></Page>;
  const save = () => guard(async () => {
    setErr("");
    if (!name.trim()) { setErr("A name is required."); return; }
    await run("Saving…", async () => {
      try {
        // a hidden field's value goes only when replaced/cleared here, or when it is being hidden now
        // (its current value moves into the Secret); otherwise the server keeps the one it has
        const params: Record<string, any> = {};
        for (const f of t.fields) if (!wasHidden.has(f.name) || replaced[f.name]) params[f.name] = vals[f.name];
        const body = { template: t.name, name: name.trim(), params, hide: newHide };
        const r = await api(inst ? "PUT" : "POST", inst ? "api/tasks/instances/" + inst.id : "api/tasks/instances", body);
        await loadTasks();
        closePage();
        if (!inst) { toast(`Saved “${r.name}”`, "ok"); openPage("task", { id: r.id }); }
      } catch (e: any) { setErr(e.message); }
    });
  });
  return (
    <Page title={inst ? "Edit task" : "New task"} onSubmit={busy ? undefined : save}
      right={<Button id="te-save" disabled={!!busy} onPress={save}>{busy ? <><Spinner /><BtnLabel>{busy}</BtnLabel></> : "Save"}</Button>}>
      <Muted mt={2}>From the template “{t.title}”{t.description ? ` — ${t.description}` : ""}</Muted>
      <Lbl>Name</Lbl>
      <TextField id="te-name" autoComplete="off" value={name} onChangeText={setName} placeholder="What this instance is for" />
      {t.fields.map((f) => {
        const hid = isHidden(f.name), server = wasHidden.has(f.name);
        const state = !server ? "" : replaced[f.name] ? (vals[f.name] === "" || vals[f.name] == null ? "will be cleared" : "will be replaced") : (inst?.hiddenSet || []).includes(f.name) ? "value set" : "empty";
        return <FieldBlock key={f.name} f={f} value={vals[f.name]} hidden={hid} state={state}
          onHide={hid ? undefined : () => hide(f)}
          onClear={server && (inst?.hiddenSet || []).includes(f.name) && !replaced[f.name] ? () => { setVals((x) => ({ ...x, [f.name]: initial(f, "") })); setReplaced((r) => ({ ...r, [f.name]: true })); } : undefined}
          onChange={(v) => { setVals((x) => ({ ...x, [f.name]: v })); if (server) setReplaced((r) => ({ ...r, [f.name]: true })); }} />;
      })}
      <Muted mt={4}>Values are committed to git in plain text, except hidden ones (an encrypted Secret, never shown again). Secrets come from the template's secret stores ({(t.stores || []).join(", ") || "none"}).</Muted>
      {!!err && <P size={2} color="red" mt={3} id="te-err">{err}</P>}
    </Page>
  );
}
function FieldBlock({ f, value, onChange, hidden, state, onHide, onClear }: { f: TaskField; value: any; onChange: (v: any) => void; hidden?: boolean; state?: string; onHide?: () => void; onClear?: () => void }) {
  return <>
    <Flex mt={4} align="flex-start" justify="space-between" gap={2}>
      <Lbl mt={0}>{f.label + (f.required ? " *" : "") + (hidden ? " · hidden" : "")}</Lbl>
      {onHide && <Button size={1} variant="ghost" color="gray" onPress={onHide} id={"tf-hide-" + f.name}>Hide</Button>}
    </Flex>
    {hidden && !!state && <Flex align="center" gap={2} mb={2}><Muted>{state === "value set" ? "Hidden · value set — type below to replace it" : "Hidden · " + state}</Muted>
      {onClear && <Button size={1} variant="ghost" color="red" onPress={onClear} id={"tf-clear-" + f.name}>Clear</Button>}</Flex>}
    <FieldInput f={f} value={value} onChange={onChange} secure={hidden} placeholder={hidden && state === "value set" ? "New value" : undefined} />
    {!!f.help && <Muted mt={1}>{f.help}</Muted>}
  </>;
}
