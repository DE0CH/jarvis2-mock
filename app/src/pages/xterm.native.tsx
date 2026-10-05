// The terminal screen's xterm on the phone: xterm.js in a WebView (scripts/xterm-bridge.js), fed
// frames by the app. It never takes the focus — typing goes through the native input bar below it.
import { forwardRef, useImperativeHandle, useRef } from "react";
import { WebView } from "react-native-webview";
import html from "../lib/xterm-html.gen";
import type { XtermHandle, XtermProps } from "./xterm.types";

export const Xterm = forwardRef<XtermHandle, XtermProps>(function Xterm({ onFit, onReady }, ref) {
  const wv = useRef<WebView>(null);
  const call = (js: string) => wv.current?.injectJavaScript(`window.jarvis && ${js}; true;`);
  useImperativeHandle(ref, () => ({
    write: (s) => call(`window.jarvis.write(${JSON.stringify(s)})`),
    resize: (c, r) => call(`window.jarvis.resize(${c | 0}, ${r | 0})`),
    refit: () => call("window.jarvis.refit()"),
  }), []);
  return (
    <WebView ref={wv} source={{ html }} originWhitelist={["*"]} style={{ flex: 1, backgroundColor: "#0b0d11" }}
      scrollEnabled={false} bounces={false} overScrollMode="never" keyboardDisplayRequiresUserAction hideKeyboardAccessoryView
      javaScriptEnabled automaticallyAdjustContentInsets={false} contentInsetAdjustmentBehavior="never"
      onMessage={(e) => { try { const m = JSON.parse(e.nativeEvent.data); if (m.type === "fit") onFit(m.cols, m.rows); else if (m.type === "ready") onReady?.(); } catch {} }} />
  );
});
