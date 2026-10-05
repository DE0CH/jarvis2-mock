// Runs inside the terminal WebView. The app draws tmux frames into xterm by calling window.jarvis.*
// (injectJavaScript) and hears back the size that fits (postMessage {type:"fit", cols, rows}).
// Typing happens in the app's own input bar, so xterm never takes the focus (no second keyboard).
(function () {
  var term = new Terminal({ cursorBlink: true, fontSize: 12, fontFamily: "Menlo, monospace", convertEol: false, scrollback: 0, theme: { background: "#0b0d11" }, allowProposedApi: true, disableStdin: true });
  var fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById("term"));
  if (term.textarea) { term.textarea.readOnly = true; term.textarea.setAttribute("inputmode", "none"); term.textarea.tabIndex = -1; }
  var post = function (m) { window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(m)); };
  var refit = function () { var d = fit.proposeDimensions(); if (d && d.cols && d.rows) post({ type: "fit", cols: d.cols, rows: d.rows }); };
  new ResizeObserver(refit).observe(document.getElementById("term"));
  window.jarvis = {
    resize: function (c, r) { if (term.cols !== c || term.rows !== r) term.resize(c, r); },
    write: function (s) { term.write(s); },
    refit: refit,
  };
  post({ type: "ready" });
  refit();
})();
