# Design decisions made while building the mock (for Deyao to review)

1. **New session is split.** The React Native form (normal mode) keeps prompt, title, attachments, permission
   mode, model, size, idle and API options. Its button says **Continue** and enters secure mode. The shell's
   native sheet decides what reaches the machine: **secret stores, harness, session image**, then **Create**
   (Face ID). The form's choices travel along as options.
2. **Pre-selection:** normal mode may pre-select non-sensitive stores only; the React Native form doesn't even
   list sensitive stores. A sensitive store is only added by a tap on the secure page, which then shows an
   amber "this session will hold sensitive secrets: …" warning.
3. **The secure screen is a page, not a sheet** (no sheets: forms are pages). It is pushed with the native
   push motion over a shell-owned snapshot of the React Native form (which slides back and dims a little),
   with the app's own top bar: ← Back · title · Create. Back pops it to the right onto the form as it was;
   a finished Create leaves to the left (the app's "go ahead" motion) and the shell tells React Native, which
   then closes the form. Both exits are the shell's own code. A blue "Secure — drawn by the Jarvis 2 shell"
   banner marks it.
4. **Only `new-session` requests** are accepted for secure mode in this mock; any other kind is refused.
5. **The image** is shown as "Latest CI build · built <date> · verified by the core" — from the core's signed
   store answer (the GitHub build attestation isn't wired yet).
6. **Phone key:** a Secure Enclave P-256 signing key, Face ID on every use (`.biometryAny`). The **simulator**
   signs with a software key instead (its Face ID can't be driven from CI); the banner says which.
7. **Mock core** = an in-process module of the mock backend (not its own pod): P-256 keys made at start and
   never stored, challenge nonces derived from the request (stateless), only new lines (predecessor null),
   fake machines. The phone's key and the core's key are learned on first use (setup is undesigned).
8. **No credentials in the app:** it only talks to the mock backend; the CI simulator uses a mock on the runner.
