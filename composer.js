/**
 * In-page model + reasoning-effort picker.
 *
 * Both are written to the agent thread record (inject.js), which is what the
 * server runs the chat with; the trial hides Notion's own model menu. The
 * block at the top always shows what the server record says, not what was
 * picked, so a pick the server refused is visible.
 *
 * Runs in the ISOLATED world for chrome.storage access and talks to inject.js
 * (MAIN world) over window.postMessage. UI lives in a shadow root so Notion's
 * stylesheet cannot reach it.
 */
(function () {
  'use strict';

  if (window.__notionEffortComposer) return;
  window.__notionEffortComposer = true;

  const merge = globalThis.NOTION_EFFORT_MERGE_CATALOGUE || (() => globalThis.NOTION_EFFORT_MODELS || []);
  const normName = globalThis.NOTION_EFFORT_NORMALIZE_NAME || ((n) => String(n || '').toLowerCase());

  // Ids learned at runtime (Notion's catalogue, or request id + menu label),
  // persisted so a new model is recognised from the first request next time.
  let learned = [];
  let MODELS = merge(learned);

  const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', max: 'Max' };
  const EFFORT_ORDER = ['low', 'medium', 'high', 'max'];
  // Notion's full scale, for showing a model's range (Grok 4.6: Low–XHigh).
  const EFFORT_SCALE = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const RANGE_LABELS = Object.assign({ minimal: 'Minimal', xhigh: 'XHigh' }, EFFORT_LABELS);
  const EFFORT_HINTS = {
    low: 'Fastest, least thinking',
    medium: 'Balanced',
    high: 'More thinking, slower',
    max: 'Most thinking, slowest',
  };

  const state = {
    effort: null, // null = leave Notion's own choice alone
    model: null, // codename; null = Notion's Auto
    open: false,
    swaps: 0,
    lastApplied: null,
    menuModel: null,
    seen: null,
    agent: null,
    agentPref: null,
    policy: null, // workspace allowed-models write (inject.js applyPolicy)
    spaceModels: null, // codenames the workspace offers (getAvailableModels), null = not read yet
  };

  function modelById(id) {
    return MODELS.find((m) => m.model === id) || null;
  }

  /** Effort ceilings per model, so inject.js can lower an unsupported ask. */
  function effortsByModel() {
    const map = {};
    MODELS.forEach((m) => {
      // null = ceiling unknown (learned model): leave it out so nothing is clamped.
      if (Array.isArray(m.efforts)) map[m.model] = m.efforts;
    });
    return map;
  }

  function learn(entries) {
    let added = 0;
    entries.forEach((e) => {
      if (!e || !e.model) return;
      const had = learned.find((l) => l.model === e.model);
      if (had) {
        // The workspace catalogue is authoritative: refresh what it says.
        if (e.source !== 'workspace') return;
        const efforts = Array.isArray(e.efforts) ? e.efforts : null;
        if (had.name === e.name && JSON.stringify(had.efforts) === JSON.stringify(efforts) && had.family === e.family) return;
        Object.assign(had, { name: e.name || had.name, efforts: efforts, family: e.family || had.family, source: 'workspace' });
        added++;
        return;
      }
      learned.push({
        model: e.model,
        name: e.name || e.model,
        efforts: e.efforts || null,
        family: e.family || undefined,
        source: e.source || 'catalogue',
      });
      added++;
    });
    if (!added) return false;
    MODELS = merge(learned);
    chrome.storage.local.set({ learnedModels: learned });
    pushSettings();
    return true;
  }

  // ------------------------------------------------------- Notion's own menu

  const AUTO_LABEL = /^auto$/i;
  const MODEL_WORD = /(opus|sonnet|haiku|fable|claude|gpt|gemini|grok|kimi|deepseek|glm)/i;

  /**
   * The label on Notion's model button next to the composer ("Auto",
   * "Opus 5.5", ...). Read by text, not class names, so a redesign of the menu
   * does not break it. Returns null when nothing model-like is on screen.
   */
  function readMenuModel() {
    const found = findComposer();
    if (!found) return null;
    let node = found.el;
    for (let depth = 0; node && depth < 7; depth++, node = node.parentElement) {
      const buttons = node.querySelectorAll('button, [role="button"], [aria-haspopup]');
      for (const b of buttons) {
        const text = (b.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 40) continue;
        if (AUTO_LABEL.test(text)) return 'Auto';
        if (MODELS.some((m) => normName(m.name) === normName(text))) return text;
        if (MODEL_WORD.test(text)) return text;
      }
    }
    return null;
  }

  /**
   * A request id we do not know, sent while the menu names a model: that pairs
   * the codename with its display name (this is how Opus 5.5 gets its id).
   * Never done for "Auto", and never over a name that already has an id.
   */
  function learnFromMenu(id, label) {
    if (!id || !label || AUTO_LABEL.test(label) || modelById(id)) return;
    if (MODELS.some((m) => normName(m.name) === normName(label))) return;
    if (learn([{ model: id, name: label, source: 'menu' }])) {
      console.log('[Notion Effort] learned', id, '=', label, '(from Notion model menu)');
    }
  }

  // ---------------------------------------------------------------- shadow UI

  const host = document.createElement('div');
  host.id = 'notion-effort-picker';
  host.style.cssText = 'position:fixed;z-index:2147483000;top:0;left:0;width:0;height:0;';
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: ui-sans-serif, -apple-system, "Segoe UI", sans-serif; }

      .pill {
        position: fixed;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 28px;
        padding: 0 8px 0 7px;
        border-radius: 7px;
        border: 1px solid rgba(255,255,255,0.13);
        background: #252525;
        color: #e9e9e7;
        font-size: 13px;
        line-height: 1;
        cursor: pointer;
        user-select: none;
        box-shadow: 0 2px 8px rgba(0,0,0,0.4);
        transition: background 120ms ease, border-color 120ms ease;
      }
      .pill:hover { background: #2f2f2f; }
      .pill.warn { border-color: rgba(214,167,74,0.7); }
      .pill.err { border-color: rgba(235,100,95,0.7); }
      .pill .eff {
        font-size: 10px;
        letter-spacing: 0.03em;
        text-transform: uppercase;
        padding: 2px 4px;
        border-radius: 4px;
        background: rgba(255,255,255,0.09);
        color: #bdbdb8;
      }
      .pill .eff.on { background: #3b6ef0; color: #fff; }
      .pill .dot { width: 6px; height: 6px; border-radius: 50%; background: #5c5c5c; }
      .pill .dot.warn { background: #d6a74a; }
      .pill .dot.err { background: #eb645f; }

      .menu {
        position: fixed;
        width: 300px;
        max-height: calc(100vh - 16px);
        display: flex;
        flex-direction: column;
        background: #252525;
        border: 1px solid rgba(255,255,255,0.11);
        border-radius: 10px;
        box-shadow: 0 12px 32px rgba(0,0,0,0.55);
        overflow: hidden;
        color: #e9e9e7;
      }
      .head {
        padding: 9px 10px 5px;
        font-size: 11px;
        font-weight: 600;
        color: #8b8b87;
      }
      .seg { display: flex; gap: 3px; padding: 0 8px 8px; flex: none; }
      .seg button {
        flex: 1; height: 28px; border: 1px solid rgba(255,255,255,0.1); border-radius: 6px;
        background: #2c2c2c; color: #d4d4d0; font-size: 12px; cursor: pointer; padding: 0;
      }
      .seg button:hover { background: #353535; }
      .seg button.sel { background: #3b6ef0; border-color: #3b6ef0; color: #fff; }
      .seg button.na { opacity: .38; }
      .effnote { padding: 0 10px 6px; font-size: 11px; color: #8a8f98; flex: none; }
      .effnote:empty { display: none; }
      .search { padding: 0 8px 6px; flex: none; }
      .search input {
        width: 100%; height: 28px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.12);
        background: #1d1d1d; color: #e9e9e7; font-size: 12.5px; padding: 0 8px; outline: none;
      }
      .search input:focus { border-color: #3b6ef0; }
      .mlist { padding: 0 6px 6px; overflow-y: auto; flex: 1 1 auto; min-height: 60px; }
      .mlist .row { padding: 5px 8px; font-size: 13px; }
      .mlist .empty { padding: 8px; font-size: 12px; color: #71716e; }
      .head { flex: none; }
      .model { flex: none; }
      .pnote { padding: 0 10px 6px; font-size: 11px; line-height: 1.35; color: #8a8f98; flex: none; }
      .pnote:empty { display: none; }
      .pnote.bad { color: #d9a44a; }
      .row .cur { font-size: 10px; color: #6f95f5; flex: none; }
      .row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 8px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 13.5px;
      }
      .row:hover { background: rgba(255,255,255,0.055); }
      .row.sel { background: rgba(255,255,255,0.075); }
      .row .name { flex: none; }
      .row .hint { flex: 1; font-size: 11px; color: #71716e; text-align: right; }
      .row .check { color: #e9e9e7; flex: none; }
      .mlist .note { padding: 2px 8px 6px; font-size: 11px; line-height: 1.35; color: #d9a44a; }
      .mlist .note.ok { color: #8a8f98; }
      .mlist .grp { padding: 7px 8px 2px; font-size: 10.5px; color: #6f6f6b; text-transform: uppercase; letter-spacing: .04em; }

      .model {
        padding: 9px 10px 8px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
      }
      .model .lbl { font-size: 11px; font-weight: 600; color: #8b8b87; }
      .model .mname { margin-top: 4px; font-size: 14px; font-weight: 600; color: #e9e9e7; }
      .model .mmeta { margin-top: 2px; font-size: 11px; color: #8b8b87; }
      .model .mmeta b { color: #e9e9e7; font-weight: 600; }
      .model .mmeta .warn { color: #d6a74a; }
      .foot {
        flex: none;
        border-top: 1px solid rgba(255,255,255,0.08);
        padding: 7px 10px;
        font-size: 11.5px;
        color: #8b8b87;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .foot .sd { width: 6px; height: 6px; border-radius: 50%; background: #5c5c5c; flex: none; }
      .foot .sd.warn { background: #d6a74a; }
      .foot .sd.err { background: #eb645f; }
      .foot .txt { flex: 1; }
      .logbtn, .logcopy {
        flex: none; font: inherit; font-size: 11px; color: #c8c8c4; cursor: pointer;
        background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
        border-radius: 5px; padding: 2px 7px;
      }
      .logbtn:hover, .logcopy:hover { background: rgba(255,255,255,0.12); }
      .logbtn[aria-expanded="true"] { background: #1f4fd1; border-color: #1f4fd1; color: #fff; }
      .log {
        flex: none; border-top: 1px solid rgba(255,255,255,0.08);
        display: flex; flex-direction: column; max-height: 220px;
      }
      .logbar {
        display: flex; align-items: center; justify-content: space-between;
        padding: 6px 10px 4px; font-size: 11px; color: #8b8b87;
      }
      .logbody {
        overflow-y: auto; padding: 0 10px 8px; user-select: text;
        font: 11px/1.45 ui-monospace, Consolas, monospace; color: #c8c8c4;
      }
      .logbody .row { white-space: pre-wrap; word-break: break-word; }
      .logbody .t { color: #6f6f6b; }
      .logbody .k { color: #8fb3ff; }
      .logbody .bad { color: #eb8a86; }
      .logbody .good { color: #7fc99a; }
      .runs { flex: none; border-top: 1px solid rgba(255,255,255,0.08); display: flex; flex-direction: column; max-height: 260px; }
      .runsbody { overflow-y: auto; padding: 0 10px 8px; user-select: text; font-size: 12px; color: #c8c8c4; }
      .runsbody .run { padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
      .runsbody .run:last-child { border-bottom: 0; }
      .runsbody .rtop { display: flex; justify-content: space-between; gap: 8px; }
      .runsbody .rname { font-weight: 600; color: #ececea; }
      .runsbody .rtime { color: #6f6f6b; font-size: 11px; flex: none; }
      .runsbody .rsub { color: #8b8b87; font-size: 11px; margin-top: 2px; word-break: break-word; }
      .runsbody .ok { color: #7fc99a; }
      .runsbody .no { color: #eb8a86; }
      .watch { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #c8c8c4; cursor: pointer; }
      .watchnote { padding: 0 10px 6px; font-size: 11px; color: #d6a74a; }
      .hidden { display: none !important; }
    </style>

    <button class="pill" type="button" part="pill">
      <span class="dot"></span>
      <span class="pname">Effort</span>
      <span class="eff">Auto</span>
    </button>

    <div class="menu hidden">
      <div class="model">
        <div class="lbl">Model in this chat (from Notion server)</div>
        <div class="mname">Send a message to see the model</div>
        <div class="mmeta"></div>
      </div>
      <div class="head">Reasoning effort</div>
      <div class="seg"></div>
      <div class="effnote"></div>
      <div class="head">Model</div>
      <div class="pnote"></div>
      <div class="search"><input type="text" placeholder="Search models…" spellcheck="false"></div>
      <div class="mlist"></div>
      <div class="runs hidden">
        <div class="logbar"><span>Which model answered (newest first)</span><label class="watch"><input type="checkbox" class="watchbox"> Watch only</label></div>
        <div class="watchnote hidden">Watch only: the extension changes nothing. Set the model in Notion Settings → Notion AI → Model controls.</div>
        <div class="runsbody"></div>
      </div>
      <div class="log hidden">
        <div class="logbar"><span>What happened (newest last)</span><button class="logcopy" type="button">Copy</button></div>
        <div class="logbody"></div>
      </div>
      <div class="foot">
        <span class="sd"></span>
        <span class="txt">No AI requests seen yet — send a message</span>
        <button class="logbtn chatbtn" type="button" aria-expanded="false">Chat</button>
        <button class="logbtn" type="button" aria-expanded="false">Log</button>
      </div>
    </div>
  `;

  const pill = shadow.querySelector('.pill');
  const pillEff = shadow.querySelector('.eff');
  const pillDot = shadow.querySelector('.dot');
  const pillName = shadow.querySelector('.pname');
  const modelLbl = shadow.querySelector('.model .lbl');
  const modelName = shadow.querySelector('.mname');
  const modelMeta = shadow.querySelector('.mmeta');
  const menu = shadow.querySelector('.menu');
  const seg = shadow.querySelector('.seg');
  const effNote = shadow.querySelector('.effnote');
  const pNote = shadow.querySelector('.pnote');
  const search = shadow.querySelector('.search input');
  const mlist = shadow.querySelector('.mlist');
  const footDot = shadow.querySelector('.sd');
  const footTxt = shadow.querySelector('.txt');
  const logBox = shadow.querySelector('.log');
  const logBody = shadow.querySelector('.logbody');
  const logBtn = shadow.querySelector('.logbtn:not(.chatbtn)');
  const chatBtn = shadow.querySelector('.chatbtn');
  const runsBox = shadow.querySelector('.runs');
  const runsBody = shadow.querySelector('.runsbody');
  const watchBox = shadow.querySelector('.watchbox');
  const watchNote = shadow.querySelector('.watchnote');
  let runs = [];
  let watchOnly = false;
  let runsOpen = false;

  function renderRuns() {
    watchBox.checked = watchOnly;
    watchNote.classList.toggle('hidden', !watchOnly);
    runsBody.textContent = '';
    if (!runs.length) {
      runsBody.textContent = 'Send a message: each one shows here with the model that really answered.';
      return;
    }
    runs.slice().reverse().forEach((r) => {
      const row = document.createElement('div');
      row.className = 'run';
      const top = document.createElement('div');
      top.className = 'rtop';
      const name = document.createElement('span');
      name.className = 'rname';
      const known = r.ran && modelById(r.ran);
      const label = known ? known.name : r.ranName;
      name.textContent = r.ran ? label + (r.effort ? ' · ' + r.effort : '') : 'waiting for the answer…';
      const time = document.createElement('span');
      time.className = 'rtime';
      time.textContent = new Date(r.at).toLocaleTimeString() + (r.isNew ? ' · new chat' : '');
      top.append(name, time);
      const sub = document.createElement('div');
      sub.className = 'rsub';
      sub.textContent = (r.ran && label !== r.ran ? 'id ' + r.ran + ' · ' : '') +
        (r.selection ? 'selection ' + r.selection + ' · ' : '') +
        'workspace allowed: ' + r.allowed +
        (r.picked ? ' · panel pick: ' + (modelById(r.picked) ? modelById(r.picked).name : r.picked) : '') +
        (r.watchOnly ? ' · watch only' : '');
      row.append(top, sub);
      if (r.inList != null) {
        const v = document.createElement('div');
        v.className = 'rsub ' + (r.inList ? 'ok' : 'no');
        v.textContent = r.inList ? 'In the allowed list ✓' : 'NOT in the allowed list: Notion chose it itself';
        row.appendChild(v);
      }
      runsBody.appendChild(row);
    });
  }

  chatBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    runsOpen = !runsOpen;
    chatBtn.setAttribute('aria-expanded', String(runsOpen));
    runsBox.classList.toggle('hidden', !runsOpen);
    if (runsOpen) window.postMessage({ type: 'NOTION_EFFORT_RUNS_REQUEST' }, '*');
    renderRuns();
  });
  watchBox.addEventListener('click', (e) => e.stopPropagation());
  shadow.querySelector('.watch').addEventListener('click', (e) => e.stopPropagation());
  watchBox.addEventListener('change', () => {
    window.postMessage({ type: 'NOTION_EFFORT_WATCH_ONLY', on: watchBox.checked }, '*');
  });
  const logCopy = shadow.querySelector('.logcopy');
  let traceEntries = [];
  let logOpen = false;

  const traceLine = (t) => new Date(t.at).toLocaleTimeString() + '  ' + t.kind + '  ' + t.text;

  function renderLog() {
    const atBottom = logBody.scrollHeight - logBody.scrollTop - logBody.clientHeight < 20;
    logBody.textContent = '';
    if (!traceEntries.length) {
      logBody.textContent = 'Nothing yet. Pick a model and send a message.';
      return;
    }
    traceEntries.forEach((t) => {
      const row = document.createElement('div');
      row.className = 'row';
      const time = document.createElement('span');
      time.className = 't';
      time.textContent = new Date(t.at).toLocaleTimeString() + ' ';
      const kind = document.createElement('span');
      kind.className = 'k';
      kind.textContent = t.kind + ' ';
      const text = document.createElement('span');
      text.textContent = t.text;
      if (/FAILED|≠|NOT |not confirmed|skipped/.test(t.text)) text.className = 'bad';
      else if (/✓/.test(t.text)) text.className = 'good';
      row.append(time, kind, text);
      logBody.appendChild(row);
    });
    if (atBottom) logBody.scrollTop = logBody.scrollHeight;
  }

  logBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    logOpen = !logOpen;
    logBtn.setAttribute('aria-expanded', String(logOpen));
    logBox.classList.toggle('hidden', !logOpen);
    if (logOpen) {
      window.postMessage({ type: 'NOTION_EFFORT_TRACE_REQUEST' }, '*');
      renderLog();
      logBody.scrollTop = logBody.scrollHeight;
    }
  });
  logCopy.addEventListener('click', (e) => {
    e.stopPropagation();
    const text = traceEntries.map(traceLine).join('\n');
    navigator.clipboard.writeText(text).then(() => {
      logCopy.textContent = 'Copied';
      setTimeout(() => { logCopy.textContent = 'Copy'; }, 1200);
    }, () => {});
  });
  try {
    modelLbl.textContent =
      'Model in this chat (from Notion server) · v' + chrome.runtime.getManifest().version;
  } catch (e) {}

  // ------------------------------------------------------------------ render

  /**
   * A verdict is evidence about one specific effort. If the selection has moved
   * on, the old result is not "still true" — showing it would let a stale
   * reading vouch for a setting it was never measured against.
   */
  function currentVerdict() {
    const la = state.lastApplied;
    if (!la) return null;
    if (!state.effort) return la.effort ? null : la;
    return la.requested === state.effort ? la : null;
  }

  /**
   * The model block reads thread.agent_provider — the record Notion's server
   * wrote for this chat — so it names the model that actually answers, not the
   * one the menu or this extension would like it to be.
   */
  /** Did our write to *this* thread go through? */
  function wroteThisThread(ag) {
    const ap = state.agentPref;
    return !!(ap && ap.status === 'ok' && ap.detail && ag &&
      String(ap.detail.thread || '').replace(/-/g, '') === String(ag.thread || '').replace(/-/g, ''));
  }

  function nameOf(id) {
    const m = modelById(id);
    return m ? m.name : id;
  }

  /** The effort inject.js sends for a pick: the nearest lower one the model takes. */
  function sentEffort(effort, m) {
    const sup = m && Array.isArray(m.efforts) ? m.efforts : null;
    if (!effort || !sup || sup.indexOf(effort) !== -1) return effort;
    if (!sup.length) return null;
    const rank = (x) => EFFORT_SCALE.indexOf(x);
    const real = sup.filter((x) => rank(x) !== -1).sort((a, b) => rank(a) - rank(b));
    const lower = real.filter((x) => rank(x) <= rank(effort));
    return lower.length ? lower.pop() : real[0] || sup[0];
  }

  /** What the picker asks for that this chat's record does not show yet. */
  function pendingText(ag) {
    const out = [];
    if (state.model && ag.model && ag.model !== state.model) out.push(nameOf(state.model) + ' on next message');
    // Compare with what is actually sent: Max on Grok 4.6 goes out as xhigh.
    const sent = sentEffort(state.effort, modelById(state.model || ag.model));
    if (sent && ag.reasoningEffort && sent !== ag.reasoningEffort) {
      const e = sent.toUpperCase();
      out.push(wroteThisThread(ag) ? 'server kept ' + ag.reasoningEffort.toUpperCase() + ', ' + e + ' ignored'
        : e + ' on next message');
    }
    return out.join(' · ');
  }

  function renderModel() {
    const ag = state.agent;
    if (!ag || !ag.model) return;
    const m = modelById(ag.model);
    modelName.textContent = (m ? m.name : ag.model) + (ag.modelSelection === 'auto' ? ' (Auto)' : '');
    modelMeta.textContent = '';
    modelMeta.append('id: ' + ag.model + ' · effort ');
    const b = document.createElement('b');
    b.textContent = (ag.reasoningEffort || '?').toUpperCase();
    modelMeta.append(b);
    const want = pendingText(ag);
    if (want) {
      const w = document.createElement('span');
      w.className = 'warn';
      w.textContent = ' · ' + want;
      modelMeta.append(w);
    }
    modelMeta.title = 'thread: ' + ag.thread + '\nselection: ' + ag.modelSelection;
  }

  function renderPill() {
    const ag = state.agent;
    const m = ag && ag.model ? modelById(ag.model) : null;
    pillName.textContent = m ? m.name : ag && ag.model ? ag.model : 'Effort';
    pillEff.textContent = state.effort ? EFFORT_LABELS[state.effort] : 'Auto';
    pillEff.classList.toggle('on', !!state.effort);

    // Green is reserved for server-confirmed, and the server never echoes the
    // effort back, so this pill deliberately has no success colour to give.
    const v = currentVerdict();
    const st = v && v.effortStatus;
    const bad = (v && v.status === 'error') || st === 'mismatch';
    pill.classList.toggle('warn', !bad && !!v && !!state.effort);
    pill.classList.toggle('err', bad);
    pillDot.classList.toggle('warn', !bad && !!v && !!state.effort);
    pillDot.classList.toggle('err', bad);
  }

  function renderFoot() {
    renderModel();
    const v = currentVerdict();
    footDot.classList.toggle('err', !!v && (v.status === 'error' || v.effortStatus === 'mismatch'));
    footDot.classList.toggle(
      'warn',
      !!v && v.status !== 'error' && v.effortStatus !== 'mismatch' && !!v.effort
    );

    if (!v || state.agent) {
      // New agent chat: no request carries the model, but the thread record
      // says what the server assigned. Report it as Notion's choice, and be
      // explicit that the extension's own effort did not reach this chat.
      const ag = state.agent;
      if (ag && (ag.model || ag.reasoningEffort)) {
        const cur = (ag.reasoningEffort || '?').toUpperCase();
        const ap = state.agentPref;
        let notOurs = '';
        const want = pendingText(ag);
        const now = nameOf(ag.model) + ' · ' + cur;
        const pol = state.policy;
        const polErr = !!pol && pol.status === 'error';
        if (polErr) notOurs = 'Model not set: ' + ((pol.detail && pol.detail.error) || 'error');
        else if (ap && ap.status === 'error') notOurs = 'Effort write failed' + (ap.detail && ap.detail.http ? ' (' + ap.detail.http + ')' : '');
        else if (want) notOurs = now + ' · ' + want;
        footTxt.textContent = notOurs ||
          (state.effort || state.model ? now + ' active in this chat' : "Notion's choice: " + now);
        footTxt.title = 'Set by Notion for this chat (thread.agent_provider)\n' +
          'model: ' + ag.model + '\nselection: ' + ag.modelSelection +
          '\nreasoningEffort: ' + ag.reasoningEffort + '\nthread: ' + ag.thread +
          (ap ? '\neffort write: ' + ap.status + ' ' + JSON.stringify(ap.detail || {}) : '') +
          (pol ? '\nallowed models: ' + pol.status + ' ' + JSON.stringify(pol.detail || {}) : '');
        footDot.classList.toggle('warn', !!notOurs);
        footDot.classList.toggle('err', polErr || (!!ap && ap.status === 'error'));
        return;
      }
      // Say which of the three it is: nothing AI-like went out at all, it went
      // out in a shape we could not patch, or it was patched and is in flight.
      const sn = state.seen;
      if (sn && sn.reason !== 'patched' && sn.reason !== 'already matched') {
        footTxt.textContent = 'AI request seen, not patched: ' + sn.reason;
        footTxt.title = sn.via + ' ' + sn.url;
        return;
      }
      footTxt.textContent = state.swaps
        ? state.swaps + ' requests patched'
        : 'No AI requests seen yet — send a message';
      return;
    }

    if (v.status === 'error') {
      footTxt.textContent = 'Rejected by server' + (v.code ? ' (' + v.code + ')' : '');
      return;
    }

    // The id the server named beats the one we sent: "Auto" resolves to a real
    // model only in the response, and a quiet substitution shows up only there.
    const isAuto = v.modelState === 'auto';
    const shownId = v.actual || (isAuto ? null : v.model);
    const m = modelById(shownId);
    const ran = m ? m.name : shownId || (isAuto ? 'Auto' : 'unknown model');

    // State how firmly the model is established, rather than printing a bare
    // name that looks equally certain whether it rests on one stray field or on
    // several agreeing ones. The exact paths go in the tooltip so the claim can
    // be audited instead of taken on faith.
    const ev = v.modelEvidence;
    let ranLabel = ran;
    const sentM = v.model && !isAuto ? modelById(v.model) : null;
    if (v.actual && v.model && !isAuto && v.actual !== v.model) {
      ranLabel = ran + ' (asked ' + (sentM ? sentM.name : v.model) + ')';
    } else if (isAuto && v.actual) {
      ranLabel = 'Auto → ' + ran;
    } else if (ev && ev.conflicting && ev.conflicting.length) {
      ranLabel = 'model unclear: ' + ev.conflicting.join(' / ');
    } else if (ev && ev.agreeing > 1 && ev.matchesRequest) {
      ranLabel = ran + ' (confirmed ×' + ev.agreeing + ' + request)';
    } else if (ev && ev.agreeing > 1) {
      ranLabel = ran + ' (confirmed ×' + ev.agreeing + ')';
    } else if (ev && ev.agreeing === 1) {
      ranLabel = ran + ' (single mention)';
    }
    const tip = [];
    if (v.model) tip.push('Request model id: ' + v.model);
    if (state.menuModel) tip.push('Notion menu: ' + state.menuModel);
    if (ev && ev.paths && ev.paths.length) tip.push('Model id reported at: ' + ev.paths.join('\n'));
    footTxt.title = tip.join('\n');

    if (!v.effort) {
      footTxt.textContent = 'Server ran ' + ranLabel;
      return;
    }

    // Model check. 'unknown' => Notion is on a model outside our catalogue, so
    // there was no effort ceiling to clamp against — flag it and show the id so
    // it can be added. 'absent' => the request carried no model field at all,
    // which is not a problem: the effort still went out, we just can't name the
    // model or clamp it. Only 'unknown' should look like a warning.
    if (v.modelState === 'unknown') {
      const id = v.model || 'unrecognised model';
      footTxt.textContent = id + ' · ' + v.effort + ' sent (unknown model, not clamped)';
      return;
    }
    if (v.modelState === 'absent') {
      footTxt.textContent = v.effort + ' sent (no model in request)';
      return;
    }
    if (isAuto) {
      footTxt.textContent = ranLabel + ' · ' + v.effort + ' sent (Auto, not clamped)';
      return;
    }
    // A lowered effort is not the one that was asked for, and hiding that would
    // be the same quiet substitution the model swap used to make.
    const asked =
      v.requested && v.requested !== v.effort
        ? v.requested + ' → ' + v.effort + ' (model limit)'
        : v.effort;
    const proof =
      v.effortStatus === 'verified'
        ? ''
        : v.effortStatus === 'mismatch'
          ? ', ran ' + v.effortActual
          : ' (unconfirmed)';
    footTxt.textContent = ranLabel + ' · ' + asked + proof;
  }

  function checkMark() {
    // Drawn rather than typed: a check glyph is missing from some of the fonts
    // Notion loads and renders as tofu.
    const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    check.setAttribute('class', 'check');
    check.setAttribute('viewBox', '0 0 12 12');
    check.setAttribute('width', '12');
    check.setAttribute('height', '12');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M1.5 6.5 4.5 9.5 10.5 2.5');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    check.appendChild(path);
    return check;
  }

  /** Efforts the picked (or running) model takes; null = unknown, anything goes. */
  function modelEfforts() {
    const m = modelById(state.model || (state.agent && state.agent.model));
    return m && Array.isArray(m.efforts) ? m.efforts : null;
  }

  function effortRange(m) {
    if (!Array.isArray(m.efforts)) return '';
    if (!m.efforts.length) return 'no effort';
    const e = EFFORT_SCALE.filter((x) => m.efforts.indexOf(x) !== -1);
    if (!e.length) return '';
    const l = (x) => RANGE_LABELS[x];
    return e.length === 1 ? l(e[0]) : l(e[0]) + '–' + l(e[e.length - 1]);
  }

  function renderPolicyNote() {
    const pol = state.policy;
    let msg = '';
    let bad = false;
    if (pol && pol.status === 'pending') msg = 'Setting workspace allowed models…';
    else if (pol && pol.status === 'error') {
      bad = true;
      msg = 'Could not set allowed models: ' + ((pol.detail && pol.detail.error) || 'error');
    } else if (state.model) {
      msg = 'Workspace allows only ' + nameOf(state.model) + '. Auto restores your list.';
    }
    const r = state.restore;
    if (r && r.status === 'error') {
      msg += (msg ? ' ' : '') + 'Could not restore the model list in another workspace: ' + (r.detail.error || 'error');
    }
    pNote.textContent = msg;
    pNote.classList.toggle('bad', bad);
  }

  function renderModelList() {
    renderPolicyNote();
    const keepScroll = mlist.scrollTop;
    mlist.textContent = '';
    const labels = globalThis.NOTION_EFFORT_FAMILY_LABELS || {};
    const order = globalThis.NOTION_EFFORT_FAMILY_ORDER || [];
    const running = state.agent && state.agent.model;
    const offered = state.spaceModels;
    const q = normName(search.value);
    const usable = MODELS.filter((m) => !m.restricted && (!offered || offered.indexOf(m.model) !== -1))
      .filter((m) => !q || normName(m.name).indexOf(q) !== -1 || m.model.indexOf(q) !== -1 ||
        normName(labels[m.family] || '').indexOf(q) !== -1);
    const rows = [];
    if (!q) rows.push({ id: null, label: 'Auto', hint: "Notion's choice" });
    order.concat(usable.map((m) => m.family).filter((f) => order.indexOf(f) === -1))
      .filter((f, i, a) => a.indexOf(f) === i)
      .forEach((f) => {
        const group = usable.filter((m) => m.family === f);
        if (!group.length) return;
        rows.push({ group: labels[f] || f });
        group.forEach((m) => rows.push({ id: m.model, label: m.name, hint: effortRange(m) }));
      });
    let selRow = null;
    rows.forEach((r) => {
      if (r.group) {
        const g = document.createElement('div');
        g.className = 'grp';
        g.textContent = r.group;
        mlist.appendChild(g);
        return;
      }
      const row = document.createElement('div');
      row.className = 'row' + (r.id === state.model ? ' sel' : '');
      if (r.id) row.title = r.id;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = r.label;
      row.appendChild(name);
      if (r.id && r.id === running) {
        const cur = document.createElement('span');
        cur.className = 'cur';
        cur.textContent = 'this chat';
        row.appendChild(cur);
      }
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = r.hint;
      row.appendChild(hint);
      if (r.id === state.model) { row.appendChild(checkMark()); selRow = row; }
      row.addEventListener('click', () => selectModel(r.id));
      mlist.appendChild(row);
    });
    if (!rows.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = 'No model matches';
      mlist.appendChild(e);
    }
    mlist.scrollTop = keepScroll;
    return selRow;
  }

  function renderEffort() {
    seg.textContent = '';
    const allowed = modelEfforts();
    [null].concat(EFFORT_ORDER).forEach((id) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = id ? EFFORT_LABELS[id] : 'Auto';
      b.title = id ? EFFORT_HINTS[id] : "Notion's own choice";
      const na = !!id && !!allowed && allowed.indexOf(id) === -1;
      b.className = (id === state.effort ? 'sel' : '') + (na ? ' na' : '');
      b.addEventListener('click', () => selectEffort(id));
      seg.appendChild(b);
    });
    const m = modelById(state.model || (state.agent && state.agent.model));
    let note = '';
    if (m && allowed && state.effort && allowed.indexOf(state.effort) === -1) {
      note = allowed.length
        ? m.name + ' supports ' + effortRange(m) + ': the nearest lower one is used'
        : m.name + ' has no effort setting';
    }
    effNote.textContent = note;
  }

  function renderList(scrollToSel) {
    renderEffort();
    const selRow = renderModelList();
    if (scrollToSel && selRow) selRow.scrollIntoView({ block: 'nearest' });
  }

  // ----------------------------------------------------------------- actions

  function pushSettings() {
    window.postMessage(
      {
        type: 'NOTION_EFFORT_SETTINGS',
        effort: state.effort,
        model: state.model,
        maxIntelligence: true,
        // Lets the response scanner tell a real model id from arbitrary strings
        // that merely sit under a "model"-ish key.
        knownModels: MODELS.map((m) => m.model).filter(Boolean),
        effortsByModel: effortsByModel(),
      },
      '*'
    );
  }

  function selectModel(id) {
    state.model = id;
    chrome.storage.local.set({ selectedModel: id });
    pushSettings();
    renderList();
    renderFoot();
  }

  function selectEffort(id) {
    state.effort = id;
    state.lastApplied = null;
    chrome.storage.local.set({ selectedEffort: id });
    pushSettings();
    renderPill();
    renderList();
    renderFoot();
  }

  function setOpen(open) {
    state.open = open;
    menu.classList.toggle('hidden', !open);
    if (open) {
      search.value = '';
      renderList(true);
      position();
      setTimeout(() => search.focus({ preventScroll: true }), 0);
    }
  }

  ['keydown', 'keyup', 'keypress', 'input', 'beforeinput', 'paste', 'copy', 'cut'].forEach((t) =>
    search.addEventListener(t, (e) => {
      e.stopPropagation();
      if (t === 'keydown' && e.key === 'Escape') { setOpen(false); return; }
      if (t === 'keydown' && e.key === 'Enter') {
        e.preventDefault();
        const first = mlist.querySelector('.row');
        if (first) first.click();
        return;
      }
      if (t === 'input') renderModelList();
    })
  );

  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!state.open);
  });
  // Capture phase runs before the menu's own handlers, so stopPropagation
  // inside the shadow root cannot guard this. Test the composed path instead,
  // otherwise every in-menu click closes the menu.
  document.addEventListener(
    'click',
    (e) => {
      if (!state.open) return;
      if (e.composedPath && e.composedPath().indexOf(host) !== -1) return;
      setOpen(false);
    },
    true
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.open) setOpen(false);
  });

  // --------------------------------------------------------------- placement

  /**
   * Anchor by geometry rather than Notion's class names: find the visible
   * composer textbox and sit just above its right edge. Falls back to a fixed
   * corner slot when no composer is on screen.
   */
  function findComposer() {
    const boxes = document.querySelectorAll('[contenteditable="true"][role="textbox"], textarea');
    let best = null;
    boxes.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 180 || r.height < 16) return;
      if (r.bottom < 0 || r.top > window.innerHeight) return;
      if (!best || r.bottom > best.rect.bottom) best = { el, rect: r };
    });
    return best;
  }

  function position() {
    const found = findComposer();
    const pw = pill.offsetWidth || 90;
    let left, top;

    if (found) {
      const r = found.rect;
      left = Math.max(8, r.right - pw);
      top = r.top - 36;
      if (top < 8) top = Math.min(window.innerHeight - 40, r.bottom + 8);
    } else {
      left = window.innerWidth - pw - 24;
      top = window.innerHeight - 64;
    }

    pill.style.left = left + 'px';
    pill.style.top = top + 'px';

    if (state.open) {
      const mw = 300;
      const mh = menu.offsetHeight || 300;
      let ml = Math.min(left, window.innerWidth - mw - 8);
      let mt = top - mh - 8;
      if (mt < 8) mt = Math.min(top + 36, window.innerHeight - mh - 8);
      menu.style.left = Math.max(8, ml) + 'px';
      menu.style.top = Math.max(8, mt) + 'px';
    }
  }

  let raf = 0;
  function schedulePosition() {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      position();
    });
  }

  window.addEventListener('resize', schedulePosition, { passive: true });
  window.addEventListener('scroll', schedulePosition, { passive: true, capture: true });
  new MutationObserver(schedulePosition).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // ------------------------------------------------------------------- wiring

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;

    if (e.data.type === 'NOTION_EFFORT_TRACE') {
      traceEntries.push(e.data.entry);
      if (traceEntries.length > 150) traceEntries.shift();
      if (logOpen) renderLog();
    }
    if (e.data.type === 'NOTION_EFFORT_RUNS' && Array.isArray(e.data.runs)) {
      runs = e.data.runs.slice();
      watchOnly = !!e.data.watchOnly;
      renderRuns();
    }

    if (e.data.type === 'NOTION_EFFORT_TRACE_ALL' && Array.isArray(e.data.entries)) {
      traceEntries = e.data.entries.slice();
      if (logOpen) renderLog();
    }

    if (e.data.type === 'NOTION_EFFORT_AGENT') {
      state.agent = {
        thread: e.data.thread,
        model: e.data.model,
        modelSelection: e.data.modelSelection,
        reasoningEffort: e.data.reasoningEffort,
      };
      renderList();
      renderPill();
      renderFoot();
      position();
    }

    if (e.data.type === 'NOTION_EFFORT_POLICY') {
      // Putting back another workspace's list is not about this chat's model.
      const p = { status: e.data.status, detail: e.data.detail || {} };
      if (p.detail.restore) state.restore = p;
      else state.policy = p;
      renderList();
      renderFoot();
    }

    if (e.data.type === 'NOTION_EFFORT_AGENT_PREF') {
      state.agentPref = { status: e.data.status, detail: e.data.detail };
      renderList();
      renderFoot();
    }

    if (e.data.type === 'NOTION_EFFORT_SEEN') {
      state.seen = { url: e.data.url, via: e.data.via, reason: e.data.reason };
      if (!currentVerdict()) renderFoot();
    }

    if (e.data.type === 'NOTION_EFFORT_SPACE_MODELS' && Array.isArray(e.data.models)) {
      state.spaceModels = e.data.models.map((m) => m.model);
      learn(e.data.models.map((m) => Object.assign({ source: 'workspace' }, m)));
      if (state.open) renderList();
    }

    if (e.data.type === 'NOTION_EFFORT_CATALOGUE' && Array.isArray(e.data.models)) {
      if (learn(e.data.models)) renderFoot();
    }

    if (e.data.type === 'NOTION_EFFORT_APPLIED') {
      state.swaps = e.data.swaps || state.swaps;
      // Read on every report: the menu can change between messages, and with
      // effort on Auto there is no 'pending' report to read it at.
      state.menuModel = readMenuModel() || state.menuModel;
      if (e.data.modelState === 'unknown') learnFromMenu(e.data.model, state.menuModel);
      state.lastApplied = {
        model: e.data.model,
        actual: e.data.actual || null,
        effort: e.data.effort,
        requested: e.data.requestedEffort || e.data.effort,
        status: e.data.status,
        code: e.data.code,
        effortStatus: e.data.effortStatus || null,
        effortActual: e.data.effortActual || null,
        // Re-derived: learnFromMenu may have just made an unknown id known.
        modelState:
          e.data.modelState === 'unknown' && modelById(e.data.model)
            ? 'known'
            : e.data.modelState || 'known',
        modelEvidence: e.data.modelEvidence || null,
      };
      renderPill();
      renderFoot();
    }

    if (e.data.type === 'NOTION_EFFORT_PONG') {
      state.swaps = e.data.swappedCount || 0;
      if (!state.lastApplied) renderFoot();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.selectedModel) state.model = changes.selectedModel.newValue || null;
    if (changes.selectedEffort) {
      state.effort = changes.selectedEffort.newValue || null;
      // A verdict belongs to the effort it was measured for. Switching from
      // another context (popup) must not leave it standing next to a new one.
      state.lastApplied = null;
    }
    renderPill();
    renderFoot();
    if (state.open) renderList();
  });

  chrome.storage.local.get(['selectedEffort', 'selectedModel', 'learnedModels'], (data) => {
    state.effort = data.selectedEffort || null;
    state.model = data.selectedModel || null;
    if (Array.isArray(data.learnedModels)) {
      learned = data.learnedModels.filter((l) => l && l.model);
      MODELS = merge(learned);
    }
    pushSettings();
    // unlock.js may have read the catalogue before this script was listening.
    window.postMessage({ type: 'NOTION_EFFORT_CATALOGUE_REQUEST' }, '*');
    window.postMessage({ type: 'NOTION_EFFORT_AGENT_REQUEST' }, '*');
    window.postMessage({ type: 'NOTION_EFFORT_SPACE_MODELS_REQUEST' }, '*');
    renderPill();
    renderFoot();
    position();
  });

  function mount() {
    if (!document.body || host.isConnected) return;
    document.body.appendChild(host);
    position();
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
  setInterval(mount, 2000);
})();
