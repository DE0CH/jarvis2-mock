// The terminal screen's xterm in the browser: xterm.js right in the page. With a desktop keyboard
// it takes keystrokes itself (onData); on a touch screen stdin is off and the input bar types.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { View } from "react-native";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { XtermHandle, XtermProps } from "./xterm.types";

export const Xterm = forwardRef<XtermHandle, XtermProps>(function Xterm({ onFit, onData }, ref) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const term = useRef<Terminal | null>(null), fit = useRef<FitAddon | null>(null);
  const cb = useRef({ onFit, onData }); cb.current = { onFit, onData };
  const refit = () => { const d = fit.current?.proposeDimensions(); if (d && d.cols && d.rows) cb.current.onFit(d.cols, d.rows); };
  useImperativeHandle(ref, () => ({
    write: (s) => term.current?.write(s),
    resize: (c, r) => { const t = term.current; if (t && (t.cols !== c || t.rows !== r)) t.resize(c, r); },
    refit,
  }), []);
  useEffect(() => {
    if (!el) return;
    const coarse = matchMedia("(pointer: coarse)").matches;
    const t = new Terminal({ cursorBlink: true, fontSize: coarse ? 12 : 13, convertEol: false, scrollback: 0, theme: { background: "#0b0d11" }, allowProposedApi: true, disableStdin: coarse });
    const f = new FitAddon(); t.loadAddon(f); t.open(el);
    term.current = t; fit.current = f;
    t.onData((d) => cb.current.onData?.(d));
    const ro = new ResizeObserver(refit); ro.observe(el);
    let alive = true;
    (document as any).fonts?.ready?.then(() => { if (alive) refit(); }); // fonts may still be loading at mount
    refit();
    return () => { alive = false; ro.disconnect(); t.dispose(); term.current = null; };
  }, [el]);
  return <View style={{ flex: 1, padding: 6, overflow: "hidden" }}><View ref={(v) => setEl(v as unknown as HTMLElement)} nativeID="term" style={{ flex: 1 }} /></View>;
});
