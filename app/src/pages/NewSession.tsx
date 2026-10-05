import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useStore, createSession, toast, loadContent, refresh } from "../lib/store";
import { pickFiles, pickDocuments, fromFiles, shrink, upload, isPicture, type Picked, type Uploaded } from "../lib/files";
import { useTheme, radius } from "../theme";
import { Button, CheckboxCards, Flex, Lbl, Muted, P, Progress, RadioCards, Spinner, TextArea, TextField, Code, type Choice } from "../ui/kit";
import { BtnLabel } from "../ui/bits";
import { Page, useDone } from "../ui/page";
import { isWeb } from "../ui/overlays";
import { API_PROXY_CHECK } from "../views/Sessions";
import { hasShell, requestSecureNewSession } from "../lib/shell";

const ATTACH_MAX_FILES = 20;
// A file travels through the cf-tunnel, whose Worker caps a request body at 25 MB.
const ATTACH_MAX_BYTES = 25 * 1024 * 1024;
// A picked attachment. It starts uploading to staging the moment it is picked, so the list shows
// its progress straight away and Start only has to wait for whatever is still in flight.
type Attach = { key: number; file: Picked; pct: number; state: "uploading" | "done" | "error"; err?: string; result?: Uploaded; ctl: AbortController };
const newId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
const fmtSize = (n: number) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");

// drag and drop onto the attachment box (web only): dragenter/leave fire for every child the pointer
// crosses, so they are counted to know when the pointer has really left the box
function useDropZone(onFiles: (p: Picked[]) => void) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0), ref = useRef<any>(null), cb = useRef(onFiles); cb.current = onFiles;
  useEffect(() => {
    const el: HTMLElement | null = isWeb ? ref.current : null;
    if (!el) return;
    const has = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
    const enter = (e: DragEvent) => { if (!has(e)) return; e.preventDefault(); depth.current++; setDragging(true); };
    const over = (e: DragEvent) => { if (!has(e)) return; e.preventDefault(); e.dataTransfer!.dropEffect = "copy"; };
    const leave = (e: DragEvent) => { if (!has(e)) return; if (--depth.current <= 0) { depth.current = 0; setDragging(false); } };
    const drop = (e: DragEvent) => { if (!has(e)) return; e.preventDefault(); depth.current = 0; setDragging(false); cb.current(fromFiles(e.dataTransfer!.files)); };
    // a file dropped anywhere else on the page would make the browser open it and lose the form
    const stop = (e: DragEvent) => { if (has(e)) e.preventDefault(); };
    el.addEventListener("dragenter", enter); el.addEventListener("dragover", over); el.addEventListener("dragleave", leave); el.addEventListener("drop", drop);
    window.addEventListener("dragover", stop); window.addEventListener("drop", stop);
    return () => { el.removeEventListener("dragenter", enter); el.removeEventListener("dragover", over); el.removeEventListener("dragleave", leave); el.removeEventListener("drop", drop); window.removeEventListener("dragover", stop); window.removeEventListener("drop", stop); };
  }, []);
  return { ref, dragging };
}

export function NewSession() {
  const t = useTheme();
  const st = useStore((s) => s.state), SIZES = useStore((s) => s.sizes), MODELS = useStore((s) => s.models);
  const envs = Object.keys(st.environments || {}), repos = st.repos || [];
  // A session can be booted from SEVERAL secret stores; their secrets are merged server-side (on a
  // key clash a value is picked at random and flagged on disk). Default to `default` if present,
  // else the first store.
  const defaultEnvs = (list: string[]) => list.includes("default") ? ["default"] : list.slice(0, 1);
  const [pickedEnvs, setPickedEnvs] = useState<string[]>(() => defaultEnvs(envs));
  const envTouched = useRef(false);
  // api/state loads async: if the form mounted before the stores were known, keep re-applying the
  // default until the user touches the picker (so a session never submits with no store selected).
  useEffect(() => { if (!envTouched.current && envs.length) setPickedEnvs(defaultEnvs(envs)); }, [envs.join(",")]);
  const pickEnvs = (v: string[]) => { envTouched.current = true; setPickedEnvs(v); };
  // Default repos: claude-env when listed, else the sole repo. The list also loads async, so the
  // default is re-applied whenever the list changes until the user touches the picker (a form
  // mounted before api/state answered once booted a session with NO repo, 2026-09-18). An explicit
  // "no repo" pick is kept.
  const defaultPick = (list: typeof repos) => list.filter((r) => r.name === "claude-env" || list.length === 1).map((r) => r.name);
  const [picked, setPicked] = useState<string[]>(() => defaultPick(repos));
  const touched = useRef(false);
  const repoKey = repos.map((r) => r.name).join(",");
  useEffect(() => { if (!touched.current) setPicked(defaultPick(repos)); }, [repoKey]);
  const pickRepos = (v: string[]) => { touched.current = true; setPicked(v); };
  // content stores (none by default): each is pulled into ~/content/<store>/ when the session boots
  const content = useStore((s) => s.content);
  const [pickedContent, setPickedContent] = useState<string[]>([]);
  useEffect(() => { loadContent(); }, []);
  const [perm, setPerm] = useState("bypass"), [model, setModel] = useState(MODELS.default), [size, setSize] = useState(SIZES.default), [autoPause, setAutoPause] = useState<string[]>(["on"]), [apiProxy, setApiProxy] = useState<string[]>([]);
  useEffect(() => { setModel((m) => m || MODELS.default); }, [MODELS.default]);
  useEffect(() => { setSize((s) => s || SIZES.default); }, [SIZES.default]);
  const [label, setLabel] = useState(""), [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<Attach[]>([]);
  const uploadId = useRef(newId()); // one staging dir per form
  const seq = useRef(0); // numbers each file: iOS hands several photos the same name (image.jpg) and
  // staging keys files by name, so a later one would overwrite an earlier one
  const patch = (key: number, p: Partial<Attach>) => setFiles((cur) => cur.map((a) => (a.key === key ? { ...a, ...p } : a)));
  async function send(a: Attach) {
    try {
      const f = await shrink(a.file);
      if (f.size > ATTACH_MAX_BYTES) throw new Error(`over ${ATTACH_MAX_BYTES / 1048576} MB`);
      const result = await upload(uploadId.current, f, `${a.key}-${f.name}`, (pct) => patch(a.key, { pct }), a.ctl.signal);
      patch(a.key, { state: "done", pct: 100, result });
    } catch (e: any) { if (!a.ctl.signal.aborted) patch(a.key, { state: "error", err: e.message }); }
  }
  function addFiles(list: Picked[]) {
    const added: Attach[] = [];
    let count = files.length;
    for (const f of list) {
      if (f.size > ATTACH_MAX_BYTES && !isPicture(f)) { toast(`“${f.name}” is over ${ATTACH_MAX_BYTES / 1048576} MB`, "error"); continue; }
      if (files.some((x) => x.file.name === f.name && x.file.size === f.size) || added.some((x) => x.file.name === f.name && x.file.size === f.size)) continue; // already picked
      if (count >= ATTACH_MAX_FILES) { toast(`At most ${ATTACH_MAX_FILES} attachments`, "error"); break; }
      added.push({ key: ++seq.current, file: f, pct: 0, state: "uploading", ctl: new AbortController() });
      count++;
    }
    if (!added.length) return;
    setFiles((cur) => [...cur, ...added]);
    added.forEach(send);
  }
  const drop = useDropZone(addFiles);
  const removeFile = (key: number) => setFiles((cur) => { cur.find((a) => a.key === key)?.ctl.abort(); return cur.filter((a) => a.key !== key); });
  const retryFile = (a: Attach) => { const b: Attach = { ...a, pct: 0, state: "uploading", err: undefined, ctl: new AbortController() }; setFiles((cur) => cur.map((x) => (x.key === a.key ? b : x))); send(b); };
  // closing the form mid-upload stops the transfers
  const filesRef = useRef(files); filesRef.current = files;
  useEffect(() => () => filesRef.current.forEach((a) => a.ctl.abort()), []);
  const pending = files.filter((a) => a.state === "uploading"), failedFiles = files.filter((a) => a.state === "error");
  const up = pending.length ? `Uploading ${files.length - pending.length}/${files.length}…` : null;
  const done = useDone();
  const starting = useRef(false); // a second tap while the first is still going is ignored
  // one create per form: Jarvis answers a repeat of this id with the first create's session
  const requestId = useRef(newId());
  // interactive (default) or one-shot: the prompt is the whole job, then the session is archived + destroyed
  const [mode, setMode] = useState<"interactive" | "oneshot">("interactive");
  // Start waits for a real environment (when any exist), and for api/state to have answered once:
  // until then the environment and repo lists are unknown and the form would submit blanks.
  const oneShot = mode === "oneshot", canStart = !up && !failedFiles.length && !!st.loaded && !(oneShot && !prompt.trim() && !files.length) && !(envs.length && !pickedEnvs.length);
  function start() {
    if (starting.current || !canStart) return;
    starting.current = true;
    // Attachments were uploaded to staging as they were picked; hand the session the manifest.
    const attachments = files.length ? { uploadId: uploadId.current, files: files.map((a) => a.result!) } : undefined;
    // Close at once: the Sessions list shows a "Creating…" card that follows the create (store.
    // createSession), so a lost reply is retried under this form's requestId, never started twice.
    const title = label.trim() || prompt.trim().split("\n")[0].slice(0, 60) || "New session";
    const body = { environments: pickedEnvs, repos: picked, content: pickedContent, label: label.trim(), permissionMode: perm, size, model, prompt: prompt.trim(), autoPause: !oneShot && autoPause.includes("on"), oneShot, attachments, apiProxy: apiProxy.includes("on") };
    // Jarvis 2: the secret stores, harness and image are chosen in the shell's secure sheet; this form
    // only pre-selects non-sensitive stores and carries the rest along.
    if (hasShell) {
      // the form stays underneath the shell's page: Back there returns to it as it was
      requestSecureNewSession({ requestId: requestId.current, title, harness: MODELS.models?.[model]?.harness || "claude", ...body }, (r) => {
        starting.current = false;
        if (r.result === "created") { refresh(false); done(); }
      });
      return;
    }
    createSession(requestId.current, title, body);
    done();
  }
  const pick = async (fn: () => Promise<Picked[]>) => { try { addFiles(await fn()); } catch (e: any) { toast("Could not open the picker: " + (e?.message || e), "error"); } };
  const docs = pickDocuments;
  return (
    <Page title="New session" onSubmit={canStart ? start : undefined}
      right={<Button id="ns-start" disabled={!canStart} onPress={start}>{up ? <><Spinner /><BtnLabel>{up}</BtnLabel></> : hasShell ? "Continue" : "Start"}</Button>}>
      <Lbl>{oneShot ? "Prompt" : "First prompt (optional)"}</Lbl>
      <TextArea id="ns-prompt" rows={4} autoCapitalize="sentences" placeholder={oneShot ? "The one job for this session. Claude runs it, then the session is archived and destroyed." : "Typed into the session as its first message once Claude is up — leave blank to start it yourself from the app."} value={prompt} onChangeText={setPrompt} />
      {oneShot && <Muted mt={1}>Needs a prompt (or an attachment). If Claude asks you something, the session waits (“needs you”) until you answer from the app, then finishes.</Muted>}
      <Lbl>Session title (optional)</Lbl>
      <TextField id="ns-title" autoComplete="off" autoCorrect={false} autoCapitalize="sentences" placeholder="e.g. refactor billing module" value={label} onChangeText={setLabel} />
      <Muted mt={1}>Shows as the session title in the Claude app too. Leave blank and the Claude session names itself.</Muted>
      <Lbl>Attachments (optional)</Lbl>
      <View ref={drop.ref} nativeID="ns-drop" style={{ flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap", padding: 12, borderRadius: radius[3], borderWidth: 1, borderStyle: "dashed", borderColor: drop.dragging ? t.accent[9] : t.gray.a[7], backgroundColor: drop.dragging ? t.accent.a[3] : undefined }}>
        <Button variant="soft" disabled={files.length >= ATTACH_MAX_FILES} onPress={() => pick(pickFiles)} id="ns-add">{isWeb ? "Add photos or files" : "Add photos"}</Button>
        {docs ? <Button variant="soft" disabled={files.length >= ATTACH_MAX_FILES} onPress={() => pick(docs)}>Add files</Button>
          : <P size={2} color="gray">{drop.dragging ? "Drop to attach" : "or drag and drop them here"}</P>}
      </View>
      {files.length > 0 && <View style={{ marginTop: 8, gap: 6 }}>
        {files.map((a) => (
          <Flex key={a.key} align="center" gap={2}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <P size={2}>{a.file.name}</P>
              <P size={1} color={a.state === "error" ? "red" : "gray"}>
                {fmtSize(a.file.size)} · {a.state === "done" ? "Uploaded" : a.state === "error" ? `Failed: ${a.err}` : a.pct ? `Uploading ${a.pct}%` : "Preparing…"}
              </P>
              {a.state === "uploading" && <Progress mt={1} size={1} value={a.pct} />}
            </View>
            {a.state === "error" && <Button variant="soft" size={1} onPress={() => retryFile(a)}>Retry</Button>}
            <Button variant="ghost" color="gray" size={1} onPress={() => removeFile(a.key)} label={`Remove ${a.file.name}`}>Remove</Button>
          </Flex>
        ))}
      </View>}
      <Muted mt={1}>Sent with the first message. Photos are attached inline for Claude to see; other files land in <Code>~/uploads</Code> for it to read. Up to {ATTACH_MAX_FILES}, {ATTACH_MAX_BYTES / 1048576} MB each (big photos are downsized first).</Muted>
      <Lbl>Permission mode</Lbl>
      <RadioCards id="ns-perm" value={perm} onChange={setPerm} options={[
        { value: "auto", title: "Auto", sub: "Auto-approve safe actions; the permission classifier gates the rest." },
        { value: "bypass", title: "Dangerously skip permissions", sub: "No prompts at all (--dangerously-skip-permissions)." },
      ]} />
      {/* a model also picks the harness: Claude Code on the subscription (Claude app), or OpenCode on OpenRouter (curated list) */}
      {Object.entries(MODELS.harnesses || { claude: { label: "Model" } }).map(([h, hv], i) => {
        const list = Object.entries(MODELS.models || {}).filter(([, v]) => (v.harness || "claude") === h);
        return list.length ? <View key={h}>
          <Lbl>{(i === 0 ? "Model — " : "") + hv.label}</Lbl>
          <RadioCards id={i === 0 ? "ns-model" : "ns-model-" + h} value={model} onChange={setModel} options={list.map(([k, v]): Choice => ({ value: k, title: v.label || k, sub: k.replace(/^(openrouter|openclaw)\//, "") }))} />
          {!!(hv as any).detail && <Muted mt={1}>{h === "opencode" ? "Runs OpenCode on your OpenRouter key; you drive it from the Paseo app or its web UI (Remote on the session card), not the Claude app. $ per million tokens in / out." : h === "openclaw" ? "Runs claw-code (your fork) inside an OpenClaw gateway on your Claude subscription, every call logged; you drive it from the OpenClaw app or its Control UI (Remote on the session card), not the Claude app." : (hv as any).detail}</Muted>}
        </View> : null;
      })}
      <Lbl>Mode</Lbl>
      <RadioCards id="ns-mode" value={mode} onChange={(v) => setMode(v as "interactive" | "oneshot")} options={[
        { value: "interactive", title: "Interactive", sub: "Stays up for a conversation in the Claude app until you destroy it." },
        { value: "oneshot", title: "One-shot", sub: "Runs the prompt above, then Claude exits and the session is archived + destroyed automatically — even with uncommitted work (you get a Discord DM if any was lost)." },
      ]} />
      <Lbl>Secret stores</Lbl>
      {hasShell && <Muted style={{ marginBottom: 8 }}>Pre-selection only — you confirm the stores on the next, secure screen. Sensitive stores can only be picked there.</Muted>}
      {envs.length ? <CheckboxCards id="ns-env" value={pickedEnvs} onChange={pickEnvs} options={envs.filter((n) => !(hasShell && (st.environments[n] as any).sensitive)).map((n) => ({ value: n, title: n, sub: `${(st.environments[n].keys || []).length} keys` }))} /> : <Muted>No secret stores yet — add one in the Environments tab.</Muted>}
      {pickedEnvs.length > 1 && <Muted mt={1}>Secrets from all selected stores are merged. If two define the same key, a value is picked at random and flagged in <Code>~/.session-secret-conflicts.json</Code>.</Muted>}
      <Lbl>Repos</Lbl>
      {repos.length ? <CheckboxCards id="ns-repo" value={picked} onChange={pickRepos} options={repos.map((r) => ({ value: r.name, title: r.name, sub: r.url }))} />
        : st.loaded ? <Muted>No repos yet — add some in the Repos tab.</Muted> : <Flex gap={2} align="center"><Spinner /><Muted>Loading repos…</Muted></Flex>}
      {!!repos.length && !picked.length && <View nativeID="ns-norepo"><Muted mt={1}>No repo selected — the session will start with an empty workspace.</Muted></View>}
      <Lbl>Content stores</Lbl>
      {content.stores.length ? <CheckboxCards id="ns-content" value={pickedContent} onChange={setPickedContent} options={content.stores.map((c) => ({ value: c.name, title: c.name, sub: `${c.files} file${c.files === 1 ? "" : "s"} → ~/content/${c.name}/` }))} />
        : content.loaded ? <Muted>No content stores yet — add one in the Content tab.</Muted>
        : content.err ? <Muted>{"Could not list content stores: " + content.err}</Muted>
        : <Flex gap={2} align="center"><Spinner /><Muted>Loading content stores…</Muted></Flex>}
      {pickedContent.length > 0 && <Muted mt={1}>Downloaded into <Code>~/content/&lt;store&gt;/</Code> when the session starts (and again on every Start after a pause). Claude uploads changes back with <Code>content-sync push</Code>.</Muted>}
      <Lbl>Machine size</Lbl>
      <RadioCards id="ns-size" value={size} onChange={setSize} options={Object.entries(SIZES.sizes || {}).map(([k, v]) => ({ value: k, title: k[0].toUpperCase() + k.slice(1), sub: v.label }))} />
      {!oneShot && <><Lbl>Idle</Lbl>
        <CheckboxCards id="ns-autopause" value={autoPause} onChange={setAutoPause} options={[{ value: "on", title: "Auto-pause when idle", sub: "Stops the machine after ~1h with nothing running to save compute. Wake it with Start — the conversation and your files are kept." }]} /></>}
      <Lbl>API</Lbl>
      <CheckboxCards id="ns-apiproxy" value={apiProxy} onChange={setApiProxy} options={[{ value: "on", title: API_PROXY_CHECK.label, sub: API_PROXY_CHECK.sub }]} />
    </Page>
  );
}
