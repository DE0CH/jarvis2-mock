// The trusted iOS shell (Jarvis 2). This app runs inside the shell's ExtensionKit extension; asking
// for secure mode is the only thing it can do: the shell decides what to show, signs with the
// Secure Enclave, and alone leaves secure mode again.
import { NativeModules } from "react-native";

const bridge = NativeModules.ShellBridge as undefined | { requestSecureMode(options: string): void };
export const hasShell = !!bridge;
/** New session: hand the normal-mode choices to the shell's secure sheet (stores, harness and image are chosen there). */
export function requestSecureNewSession(options: Record<string, unknown>) {
  bridge?.requestSecureMode(JSON.stringify({ kind: "new-session", ...options }));
}
