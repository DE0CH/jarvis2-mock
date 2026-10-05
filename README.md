# Jarvis 2 (mock)

A mock of Jarvis 2's iPhone app: a small native **Swift shell** that owns the screen and hosts the whole
Jarvis React Native UI inside a bundled **ExtensionKit extension** (its own process). Security-relevant
steps run in the shell's **secure mode**: the extension's view is removed, and the shell shows its own
native sheet (styled like the app) whose choices are signed with the phone's Secure Enclave key and checked
by a mock **secrets-controller core**.

- `app/` — the Jarvis app (Expo / React Native), with a mock login and New session handing off to the shell
- `app/ios/` — XcodeGen project: `Shell/` (Jarvis2 app), `Extension/` (JarvisUI, React Native), `UITests/`
- `server/` — mock backend: canned Jarvis API + `core.js` (signed challenges and certs; fake machines)

No real credentials: the app talks only to the mock backend. CI builds it on GitHub's macOS runners and
walks it on an iPhone simulator; screenshots are in each run's `results` artifact.
