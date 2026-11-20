// CI-only CDP instrumentation of the packaged window. No probe is shipped in
// the app or added to contextBridge. All sockets, commands and events are bounded.
export async function connectProbe(url, timeout = 20000) {
  const socket = new WebSocket(url), pending = new Map(), listeners = new Set();
  let serial = 0;
  const rejectAll = error => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  socket.onmessage = message => {
    const reply = JSON.parse(message.data), item = pending.get(reply.id);
    if (item) {
      pending.delete(reply.id); clearTimeout(item.timer);
      if (reply.error || reply.result?.exceptionDetails) item.reject(new Error(`CDP probe: ${JSON.stringify(reply)}`));
      else item.resolve(reply.result);
    } else for (const listener of [...listeners]) listener(reply);
  };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('CDP probe socket timeout')); }, timeout);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('CDP probe socket error')); };
  });
  socket.onerror = () => rejectAll(new Error('CDP probe socket error'));
  socket.onclose = () => rejectAll(new Error('CDP probe socket closed'));
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP probe ${method} timeout`)); }, timeout);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => (await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
  return { command, evaluate, listeners, close() { rejectAll(new Error('CDP probe closed')); listeners.clear(); socket.close(); } };
}

// The sandbox's process is a parameter of Electron's preload wrapper, not a
// page global. Pause at its argv read on a picker-only reload and read that
// call frame; checking the main world or a copied renderer flag would not prove it.
export async function probeSandbox(cdp, { requireSandbox = true } = {}) {
  const scripts = [];
  const collect = event => { if (event.method === 'Debugger.scriptParsed' && /[/\\]generated[/\\]preload\.cjs$/.test(event.params.url)) scripts.push(event.params); };
  cdp.listeners.add(collect);
  let paused = false, timer, hearPause;
  try {
    await cdp.command('Debugger.enable');
    const script = scripts.at(-1);
    if (!script) throw new Error('packaged bundled preload script was not found by CDP');
    const { scriptSource } = await cdp.command('Debugger.getScriptSource', { scriptId: script.scriptId });
    const lineNumber = scriptSource.split('\n').findIndex(line => line.includes('process.argv.includes('));
    if (lineNumber < 0) throw new Error('packaged preload argv read was not found');
    await cdp.command('Debugger.setBreakpointByUrl', { url: script.url, lineNumber });
    const stopped = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('sandbox preload breakpoint timeout')), 15000);
      hearPause = event => {
        if (event.method === 'Debugger.paused') { paused = true; clearTimeout(timer); resolve(event.params); }
      };
      cdp.listeners.add(hearPause);
    });
    // Page.reload may not answer until execution resumes: don't await it first.
    const reload = cdp.command('Page.reload', { ignoreCache: true });
    // Both promises are observed immediately, including the failure path.
    const stop = await Promise.race([stopped, reload.then(() => stopped)]);
    const result = await cdp.command('Debugger.evaluateOnCallFrame', {
      callFrameId: stop.callFrames[0].callFrameId,
      expression: '({ sandboxed: process.sandboxed, isolated: process.contextIsolated, argv: process.argv })', returnByValue: true,
    });
    const state = result.result?.value;
    if (state?.isolated !== true || !Array.isArray(state.argv)) throw new Error(`invalid isolated preload state: ${JSON.stringify(state)}`);
    if (requireSandbox && state.sandboxed !== true) throw new Error(`preload is not sandboxed: ${JSON.stringify(state)}`);
    await cdp.command('Debugger.resume'); paused = false;
    await reload;
    return state;
  } finally {
    clearTimeout(timer); cdp.listeners.delete(collect); cdp.listeners.delete(hearPause);
    try { if (paused) await cdp.command('Debugger.resume'); }
    finally { await cdp.command('Debugger.disable'); }
  }
}

export async function probeTerminal(cdp, endpoint, dropPath) {
  // Reuse the launch tab's original lease and listen through the real bridge.
  const handle = await cdp.evaluate(`(async () => {
    const result = await oatsDesktop.termOpen(${JSON.stringify({ session: endpoint.session, window: endpoint.window, socket: endpoint.socket })});
    if (!result.ok || result.status !== 'reused') throw new Error('the existing launch terminal was not reused');
    window.__sandboxProbeOutput = '';
    window.__sandboxProbeOff = oatsDesktop.onTermData(result.handle, data => { window.__sandboxProbeOutput += data; });
    return result.handle;
  })()`);
  if (!handle?.lease) throw new Error('terminal probe has no lease');
  const point = await cdp.evaluate(`(() => {
    const wrap = document.querySelector('.tab-pane.active:not([hidden]) .term-wrap');
    const input = wrap?.querySelector('textarea');
    if (!input) throw new Error('terminal input is absent');
    input.focus();
    const rect = wrap.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  const text = 'OATS_SANDBOX_INPUT';
  await cdp.command('Input.insertText', { text });
  // The harness prints the hex of each raw chunk. Remove chunk delimiters so
  // transport chunking cannot change what the round-trip check asserts.
  const output = await cdp.evaluate(`new Promise((resolve, reject) => {
    const until = Date.now() + 10000;
    const expected = ${JSON.stringify(Buffer.from(text).toString('hex'))};
    function check() {
      const output = window.__sandboxProbeOutput.replace(/INPUT:|\\s/g, '');
      if (output.includes(expected)) resolve(true);
      else if (Date.now() >= until) reject(new Error('terminal output did not return through onTermData'));
      else setTimeout(check, 50);
    } check();
  })`);
  if (output !== true) throw new Error('terminal output probe failed');
  // Let the renderer's normal drop handler own the single attachment batch.
  // The smoke checks the exact path in the harness receipt after the paste.
  // A synthetic File or an attachment failure cannot produce that path.
  const data = { items: [], files: [dropPath], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.command('Input.dispatchDragEvent', { type, ...point, data });
  await cdp.evaluate('window.__sandboxProbeOff()');
  return text;
}

export async function probeWorkspace(cdp, { port, targetId, deployment }) {
  const choices = await cdp.evaluate('oatsDesktop.windowChoices()');
  const workspace = choices?.workspaces?.find(row => row.id === deployment || row.deployments?.includes(deployment))?.id;
  if (!workspace) throw new Error('fixture deployment has no served workspace');
  const claim = await cdp.evaluate(`oatsDesktop.windowClaimWorkspace(${JSON.stringify(workspace)})`);
  if (claim?.ok !== true || claim.workspace !== workspace) throw new Error('workspace claim round-trip failed');
  // Record only messages the real main sends. The shell remains subscribed and
  // answers through windowReleaseAnswer; takeover must return its layout.
  await cdp.evaluate(`window.__sandboxProbeRelease = null;
    window.__sandboxProbeReleaseOff = oatsDesktop.onWorkspaceRelease(message => { window.__sandboxProbeRelease = message; });`);
  const opened = await cdp.evaluate('oatsDesktop.windowOpenWorkspace(null)');
  if (opened?.ok !== true || !opened.opened) throw new Error('workspace probe could not open a chooser');
  let chooser;
  const deadline = Date.now() + 15000;
  do {
    const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(2000) });
    chooser = (await response.json()).find(target => target.id !== targetId && target.type === 'page' && /index\.html/.test(target.url));
    if (!chooser) await new Promise(resolve => setTimeout(resolve, 100));
  } while (!chooser && Date.now() < deadline);
  if (!chooser) throw new Error('workspace chooser CDP target absent');
  const other = await connectProbe(chooser.webSocketDebuggerUrl);
  try {
    await other.evaluate(`new Promise((resolve, reject) => {
      const until = Date.now() + 10000;
      function check() {
        if (window.oatsDesktop && document.querySelectorAll('#nav .nav-item').length) resolve(true);
        else if (Date.now() >= until) reject(new Error('chooser shell not ready'));
        else setTimeout(check, 50);
      } check();
    })`);
    const taken = await other.evaluate(`oatsDesktop.windowClaimWorkspace(${JSON.stringify(workspace)}, { takeOver: true })`);
    const release = await cdp.evaluate('window.__sandboxProbeRelease');
    if (taken?.ok !== true || taken.workspace !== workspace || !taken.layout || release?.workspace !== workspace || !Number.isSafeInteger(release.request))
      throw new Error(`workspace takeover/release round-trip failed: ${JSON.stringify({ taken, release })}`);
    const answered = await cdp.evaluate(`oatsDesktop.windowReleaseAnswer(${release.request}, null)`);
    if (answered?.ok !== false || answered.code !== 'unknown-request') throw new Error('release answer was not consumed exactly once');
    await cdp.evaluate('window.__sandboxProbeReleaseOff()');
    const unbound = await other.evaluate('oatsDesktop.windowClaimWorkspace(null)');
    if (unbound?.ok !== true) throw new Error('workspace unbind round-trip failed');
  } finally { other.close(); }
}
