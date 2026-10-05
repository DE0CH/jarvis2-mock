// The trusted iOS shell (Jarvis 2). This app runs inside the shell's ExtensionKit extension; asking
// for secure mode is the only thing it can do: the shell decides what to show, signs with the
// Secure Enclave, and alone leaves secure mode again — then tells this app how it ended.
import { NativeEventEmitter, NativeModules } from "react-native";

const bridge = NativeModules.ShellBridge as undefined | { requestSecureMode(options: string): void };
const events = bridge ? new NativeEventEmitter(NativeModules.ShellBridge) : null;
export const hasShell = !!bridge;
export type SecureResult = { requestId?: string; result: "created" | "back"; id?: string };

/** New session: push the shell's secure page (stores, harness and image are chosen there) on top of
 *  this form; `done` runs when the shell comes back, with how it ended. */
export function requestSecureNewSession(options: Record<string, unknown>, done: (r: SecureResult) => void) {
  const sub = events?.addListener("secureFinished", (body: string) => {
    let r: SecureResult = { result: "back" };
    try { r = JSON.parse(body); } catch {}
    if (r.requestId && r.requestId !== options.requestId) return;
    sub?.remove();
    done(r);
  });
  bridge?.requestSecureMode(JSON.stringify({ kind: "new-session", ...options }));
}
