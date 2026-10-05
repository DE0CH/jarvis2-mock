// Remote control of a session the Claude app does not see (api/sessions/:id/remote):
//   OpenCode  its Paseo daemon publishes a web UI through the session's tunnel behind Cloudflare Access, and
//             is also reachable from the Paseo iPhone/desktop app, paired with the link below (over Paseo's
//             end-to-end-encrypted relay).
//   OpenClaw  the gateway's Control UI on the same tunnel origin (the link carries the gateway token); Deyao's
//             OpenClaw app finds the session by itself through Jarvis (GET /api/remotes), nothing to pair here.
import { useEffect, useState } from "react";
import { Linking, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import QRCode from "qrcode";
import { SvgXml } from "react-native-svg";
import { api } from "../lib/api";
import { toast } from "../lib/store";
import { Button, Flex, Lbl, Muted, P, Spinner } from "../ui/kit";
import { Page } from "../ui/page";
import { openExternal } from "../views/Settings";

export type RemoteSpec = { id: string; title: string };
type RemoteInfo = { webUrl: string; harness?: string; pairUrl?: string; relay?: boolean; url?: string; token?: string };

export function Remote({ spec }: { spec: RemoteSpec }) {
  const [info, setInfo] = useState<RemoteInfo | null>(null), [err, setErr] = useState("");
  useEffect(() => {
    let live = true;
    api<RemoteInfo>("GET", "api/sessions/" + spec.id + "/remote").then((j) => { if (live) setInfo(j); }, (e) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [spec.id]);
  // a real square QR (SVG, dark on white with a quiet zone) built from the link itself — the daemon's
  // text-art QR renders squashed and inherits the theme's colours.
  // app.paseo.sh has no iOS universal link, so its https link only ever opens Paseo's WEB app (which
  // asks for the link again); the native app registers the paseo:// scheme and imports any URL with
  // #offer= on open, so the button and the QR use that
  const appUrl = info?.pairUrl && info.pairUrl.includes("#offer=") ? "paseo:///" + info.pairUrl.slice(info.pairUrl.indexOf("#offer=")) : "";
  const [qr, setQr] = useState("");
  useEffect(() => {
    if (!appUrl) return;
    let live = true;
    QRCode.toString(appUrl, { type: "svg", margin: 4, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } }).then((svg) => { if (live) setQr(svg); }, () => {});
    return () => { live = false; };
  }, [appUrl]);
  const copyText = (what: string, value: string) => async () => {
    try { await Clipboard.setStringAsync(value); toast(what + " copied", "ok"); }
    catch { toast("Could not copy — long-press it instead", "error"); }
  };
  return (
    <Page title={spec.title}>
      {err ? <P size={2} color="red" mt={3}>{err}</P>
        : !info ? <Flex justify="center" gap={2} align="center" mt={6}><Spinner /><P size={3} color="gray">Loading…</P></Flex>
        : <>
            <Lbl>Web UI</Lbl>
            <Button id="rm-web" href={info.webUrl} onPress={() => openExternal(info.webUrl)}>{info.harness === "openclaw" ? "Open the Control UI" : "Open the web UI"}</Button>
            {info.harness === "openclaw"
              ? <Muted mt={1}>The session’s OpenClaw Control UI, behind the same Cloudflare login as this dashboard. The link carries the gateway token — don’t share it. The OpenClaw app lists this session by itself once the app is paired with Jarvis.</Muted>
              : <Muted mt={1}>The session’s own Paseo page, behind the same Cloudflare login as this dashboard. One session’s web UI per browser at a time — opening another session’s moves it over.</Muted>}
            {!!info.pairUrl && <>
              <Lbl>Paseo app</Lbl>
              <Flex gap={2} wrap>
                <Button id="rm-pair" href={appUrl || info.pairUrl} self onPress={() => Linking.openURL(appUrl || info.pairUrl!)}>Pair this device</Button>
                <Button variant="soft" color="gray" onPress={copyText("Pairing link", info.pairUrl)}>Copy pairing link</Button>
              </Flex>
              <Muted mt={1}>Opens the Paseo app with this session’s pairing offer (or paste the copied link under “Paste pairing link” in the app). The link is the key to the session — don’t share it. From another device, scan with the camera:</Muted>
              {!!qr && <View nativeID="rm-qr" style={{ marginTop: 8, width: "100%", maxWidth: 320, aspectRatio: 1, backgroundColor: "#fff", borderRadius: 8, overflow: "hidden" }}><SvgXml xml={qr} width="100%" height="100%" /></View>}
            </>}
          </>}
    </Page>
  );
}
