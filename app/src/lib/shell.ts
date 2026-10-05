// The trusted iOS shell (Jarvis 2). On the web there is no shell: secure mode doesn't exist there.
export const hasShell = false;
export type SecureResult = { requestId?: string; result: "created" | "back"; id?: string };
export function requestSecureNewSession(_options: Record<string, unknown>, _done: (r: SecureResult) => void) {}
