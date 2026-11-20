// One line read from a terminal with echo off, for a secret a person types or
// pastes: an aweb API key (resident create), an invite token (setup).

/** Reads one line from the terminal in raw mode, echoing nothing. `prompt` is
 *  written to stderr once echo is off; `cancelled()` and `empty()` make the
 *  errors for Ctrl-C and for Ctrl-D on an empty line. */
export function promptHidden(stdin, stderr, { prompt, cancelled, empty }) {
  return new Promise((done, reject) => {
    let value = "";
    const finish = (error) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write("\n");
      // Terminals in bracketed-paste mode wrap a paste in these markers.
      if (error) reject(error); else done(value.replace(/\x1b\[20[01]~/g, "").trim());
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003") return finish(cancelled());
        if (ch === "\u0004") { if (!value) return finish(empty()); continue; }
        if (ch === "\u007f" || ch === "\b") { value = value.slice(0, -1); continue; }
        value += ch;
      }
    };
    // Echo goes off before the prompt shows, so nothing typed after it is echoed.
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.on("data", onData);
    stdin.resume();
    stderr.write(prompt);
  });
}
