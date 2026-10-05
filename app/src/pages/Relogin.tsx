// Re-login runs the real `claude auth login` in the auth broker; Jarvis relays the URL
// and the pasted code.
import { useState } from "react";
import { api } from "../lib/api";
import { refresh, toast } from "../lib/store";
import { Button, Lbl, Muted, P, Spinner, TextField } from "../ui/kit";
import { BtnLabel, useBusy } from "../ui/bits";
import { Page, closePage } from "../ui/page";
import { openExternal } from "../views/Settings";

export function Relogin({ url }: { url: string }) {
  const [code, setCode] = useState(""), [msg, setMsg] = useState("");
  const [busy, run, guard] = useBusy();
  const finish = () => guard(async () => {
    if (!code.trim()) { setMsg("Paste the code first."); return; }
    await run("Signing in…", async () => {
      try { await api("POST", "api/auth/code", { code: code.trim() }); closePage(); await refresh(false); toast("Signed in. New sessions will use the refreshed credentials.", "ok"); }
      catch (e: any) { setMsg(e.message); }
    });
  });
  return (
    <Page title="Re-login to Claude" onSubmit={busy ? undefined : finish}
      right={<Button disabled={!!busy} onPress={finish} id="auth-finish">{busy ? <><Spinner /><BtnLabel>{busy}</BtnLabel></> : "Finish"}</Button>}>
      <Muted mt={2}>1. Open the link and sign in (it shows a code at the end).</Muted>
      <Button style={{ marginTop: 8 }} onPress={() => openExternal(url)}>Open sign-in page ↗</Button>
      <Muted mt={1} selectable>{url}</Muted>
      <Lbl>2. Paste the code</Lbl>
      <TextField id="auth-code" autoComplete="off" autoCorrect={false} autoCapitalize="none" placeholder="code#state" value={code} onChangeText={setCode} onSubmitEditing={finish} />
      {!!msg && <P size={2} color="red" mt={2}>{msg}</P>}
    </Page>
  );
}
