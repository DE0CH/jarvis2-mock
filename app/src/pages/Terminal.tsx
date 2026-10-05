// Live terminal: a tmux mirror of the session (lib/tty.js) — one snapshot per second over the
// API, keystrokes forwarded as tmux send-keys. xterm.js renders the frame (xterm.tsx in the browser,
// xterm.native.tsx in a WebView in the app); the title bar, key row and input bar are native.
//
// A full-screen page, always dark: close with ✕, Back, or the swipe-back. Any change of the terminal
// area (open, rotation, keyboard) refits xterm and resizes the remote tmux window to match.
import { useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { api } from "../lib/api";
import { ForceScheme } from "../theme";
import { Button, Flex, Heading, P, TextField, mono } from "../ui/kit";
import { closePage } from "../ui/page";
import { Xterm } from "./xterm";
import type { XtermHandle } from "./xterm.types";
import { TermBody, useTermFrame } from "./termFrame";

const KEYS: [string, string][] = [["Enter", "Enter"], ["Esc", "Escape"], ["Tab", "Tab"], ["⇧Tab", "S-Tab"], ["↑", "Up"], ["↓", "Down"], ["←", "Left"], ["→", "Right"], ["⌫", "BSpace"], ["^C", "C-c"], ["^D", "C-d"], ["^L", "C-l"], ["^U", "C-u"]];
// a desktop keyboard typing into xterm itself (browser only)
const XKEY: Record<string, string> = { "\r": "Enter", "\x7f": "BSpace", "\x1b": "Escape", "\x03": "C-c", "\t": "Tab", "\x1b[A": "Up", "\x1b[B": "Down", "\x1b[C": "Right", "\x1b[D": "Left", "\x1b[Z": "S-Tab", "\x04": "C-d", "\x0c": "C-l", "\x15": "C-u" };
const BAR = "#161a22";

export function TerminalPage({ session }: { session: { id: string; title: string } }) {
  const id = session.id;
  const ins = useSafeAreaInsets(), frame = useTermFrame();
  const x = useRef<XtermHandle>(null);
  const [status, setStatus] = useState("connecting…");
  const [text, setText] = useState("");

  // Input goes out strictly in order, one request at a time: each POST is its own exec into tmux
  // on Jarvis, so concurrent ones could land swapped (fast typing came out garbled). Text typed
  // while one is in flight is merged into the next request.
  const outq = useRef<{ text?: string; keys?: string[] }[]>([]), sending = useRef(false);
  async function send(body: { text?: string; keys?: string[] }) {
    const q = outq.current, lastB = q[q.length - 1];
    if (body.text && !body.keys && lastB && lastB.text && !lastB.keys) lastB.text += body.text; else q.push({ ...body });
    if (sending.current) return;
    sending.current = true;
    try {
      while (q.length) {
        const b = q.shift()!;
        try { await api("POST", `api/sessions/${id}/tty/input`, b); } catch (e: any) { setStatus(e.message); }
      }
    } finally { sending.current = false; }
  }
  function sendText() { const t = text; setText(""); send(t ? { text: t, keys: ["Enter"] } : { keys: ["Enter"] }); }
  const onData = (data: string) => { if (XKEY[data]) send({ keys: [XKEY[data]] }); else if (!data.startsWith("\x1b")) send({ text: data }); };

  // ---- auto-fit: whenever the terminal area changes size, resize xterm + the remote tmux
  const wanted = useRef<{ cols: number; rows: number; at: number } | null>(null), timer = useRef<any>(null);
  const onFit = (c: number, r: number) => {
    const cols = Math.max(40, Math.min(300, c)), rows = Math.max(10, Math.min(120, r));
    x.current?.resize(cols, rows);
    const w = wanted.current;
    if (w && w.cols === cols && w.rows === rows) return;
    wanted.current = { cols, rows, at: Date.now() };
    clearTimeout(timer.current);
    timer.current = setTimeout(() => api("POST", `api/sessions/${id}/tty/resize`, { cols, rows }).catch((e) => setStatus(e.message)), 250);
  };

  // ---- poll one snapshot per second (only repaint when it changed); SSE doesn't survive the tunnel relay.
  // One frame request at a time, the next a second after the last answered: overlapping polls on a
  // slow tunnel could paint an older frame over a newer one.
  // the last frame painted (the next identical one is skipped); cleared when xterm (re)starts
  const last = useRef("");
  useEffect(() => {
    let alive = true, next: any = null;
    last.current = "";
    const tick = async () => {
      try {
        const f = await api("GET", `api/sessions/${id}/tty/frame`);
        if (!alive) return;
        const key = f.screen + "|" + f.x + "," + f.y + "," + f.cols + "," + f.rows + "," + f.cursor;
        if (key === last.current) return; last.current = key;
        // right after we asked tmux for a new size, frames still carry the old one for a moment —
        // keep xterm at the fitted size instead of flapping back
        const w = wanted.current, fresh = w && Date.now() - w.at < 6000 && (w.cols !== f.cols || w.rows !== f.rows);
        if (!fresh) x.current?.resize(f.cols, f.rows);
        // repaint, park the cursor where tmux says, and show it only if the app shows its own
        x.current?.write("\x1b[?25l\x1b[H\x1b[2J" + String(f.screen).replace(/\n/g, "\r\n") + `\x1b[${(f.y | 0) + 1};${(f.x | 0) + 1}H` + (f.cursor === false ? "" : "\x1b[?25h"));
        setStatus(`live · ${f.cols}×${f.rows}`);
      } catch (e: any) { if (alive) setStatus(e.message); }
    };
    const loop = async () => { await tick(); if (alive) next = setTimeout(loop, 1000); };
    loop();
    return () => { alive = false; clearTimeout(next); clearTimeout(timer.current); };
  }, [id]);

  return (
    <ForceScheme scheme="dark">
      <StatusBar style="light" />
      <View nativeID="terminal" accessibilityLabel="Terminal" style={[{ backgroundColor: "#0b0d11" }, frame.style]}>
        <Flex align="center" gap={2} style={{ paddingTop: 8 + ins.top, paddingBottom: 8, paddingHorizontal: 10, borderBottomWidth: 1, borderBottomColor: "#222", backgroundColor: BAR }}>
          <Heading size={3} lines={1} style={{ flex: 1, minWidth: 0 }}>{session.title}</Heading>
          <P size={1} lines={1} id="term-status" style={{ fontSize: 11, color: "#9aa1ab", maxWidth: "45%" }}>{status}</P>
          <Button variant="soft" color="gray" size={1} onPress={closePage} label="Close" id="term-close">✕</Button>
        </Flex>
        <TermBody>{(kb) => <>
          <Xterm ref={x} onFit={onFit} onData={onData} onReady={() => { last.current = ""; }} />
          <ScrollView nativeID="term-keys" horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, borderTopWidth: 1, borderTopColor: "#222", backgroundColor: BAR }} contentContainerStyle={{ gap: 6, paddingHorizontal: 8, paddingVertical: 6 }}>
            {/* key chips must not steal focus from the input (that would drop the keyboard) */}
            {KEYS.map(([l, k]) => <Button key={k} variant="soft" color="gray" size={1} keepFocus onPress={() => send({ keys: [k] })}>{l}</Button>)}
          </ScrollView>
          <Flex gap={2} style={{ paddingHorizontal: 8, paddingTop: 6, paddingBottom: kb ? 8 : 8 + ins.bottom, backgroundColor: BAR }}>
            <TextField id="term-in" style={{ flex: 1, fontFamily: mono }} autoComplete="off" autoCorrect={false} autoCapitalize="none" spellCheck={false}
              returnKeyType="send" submitBehavior="submit" placeholder="type, then Send (adds Enter)" value={text} onChangeText={setText} onSubmitEditing={sendText} />
            <Button variant="soft" color="gray" keepFocus onPress={sendText} id="term-send">Send</Button>
          </Flex>
        </>}</TermBody>
      </View>
    </ForceScheme>
  );
}
export { closePage };
