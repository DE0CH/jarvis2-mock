export type XtermHandle = { write: (s: string) => void; resize: (cols: number, rows: number) => void; refit: () => void };
// onFit: the size that fits the area now (on open, rotation, keyboard); onData: keys typed into
// xterm itself (a desktop keyboard in the browser — the phone types into the input bar instead)
// onReady: xterm can draw now — anything written before (the app's WebView still loading) was lost
export type XtermProps = { onFit: (cols: number, rows: number) => void; onData?: (data: string) => void; onReady?: () => void };
