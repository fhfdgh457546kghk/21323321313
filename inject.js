(function() {
  'use strict';

  // inject.js now runs as a MAIN-world content script; content.js still appends it
  // as a <script> tag on older Chrome builds, so only the first copy may wrap fetch.
  if (window.__notionEffortInjected) return;
  window.__notionEffortInjected = true;

  let interceptedCount = 0;
  let swappedCount = 0;
  let lastRequestedEffort = null;
  // Tri-state so the picker can tell "no model in the request" (nothing to
  // clamp, not alarming) apart from "model present but outside our catalogue"
  // (worth flagging, and worth surfacing its id so it can be added).
  //   'known'   → model present and recognised
  //   'unknown' → model present, not in our catalogue
  //   'absent'  → no model field in this request body
  //   'auto'    → Notion's menu is on "Auto"; the server picks the model
  let lastModelState = 'known';
// model: codename picked in the in-page picker (null = Notion's Auto). It is
// applied through the workspace's allowed-models policy (applyPolicy).
let settings = {
  effort: null,
  model: null,
  maxIntelligence: true,
  knownModels: [],
  effortsByModel: {},
};

  // ---- Trace: a readable log of every step, shown in the panel (Log) -----
  // No message text and no account data: only models, efforts, ids.
  const traceLog = [];
  function trace(kind, text) {
    const entry = { at: new Date().toISOString(), kind: kind, text: text };
    traceLog.push(entry);
    if (traceLog.length > 150) traceLog.shift();
    console.log('[Notion Effort] ' + kind + ': ' + text);
    window.postMessage({ type: 'NOTION_EFFORT_TRACE', entry: entry }, '*');
  }
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.type === 'NOTION_EFFORT_TRACE_REQUEST') {
      window.postMessage({ type: 'NOTION_EFFORT_TRACE_ALL', entries: traceLog }, '*');
    }
  });

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (e.data && e.data.type === 'NOTION_EFFORT_SETTINGS') {
      const before = (settings.model || 'auto') + '/' + (settings.effort || 'auto');
      settings.effort = e.data.effort || null;
      if ('model' in e.data) settings.model = e.data.model || null;
      if (before !== (settings.model || 'auto') + '/' + (settings.effort || 'auto')) {
        setTimeout(() => trace('pick', 'model ' + modelLabel(settings.model) + ' · effort ' + (settings.effort || 'Auto')), 0);
      }
      settings.maxIntelligence = e.data.maxIntelligence !== false;
      if (Array.isArray(e.data.knownModels) && e.data.knownModels.length) {
        settings.knownModels = e.data.knownModels;
      }
      if (e.data.effortsByModel) settings.effortsByModel = e.data.effortsByModel;
    }
    if (e.data && e.data.type === 'NOTION_EFFORT_PING') {
      window.postMessage({
        type: 'NOTION_EFFORT_PONG',
        interceptCount: interceptedCount,
        swappedCount: swappedCount,
      }, '*');
    }
  });

  /**
   * Report what actually went out on the wire so the in-page picker can show
   * proof rather than an assumption. `status` is 'pending' before the request
   * resolves, then 'ok' or 'error' once the server answers.
   */
  function notifyApplied(
    model,
    effort,
    status,
    code,
    actual,
    effortStatus,
    effortActual,
    modelEvidence
  ) {
    window.postMessage({
      type: 'NOTION_EFFORT_APPLIED',
      model: model,
      // How many independent payload paths named this model, whether the
      // request agreed, and any conflicting ids. Lets the picker state its
      // confidence instead of asserting one.
      modelEvidence: modelEvidence || null,
      effort: effort || null,
      status: status,
      code: code || null,
      actual: actual || null,
      effortStatus: effortStatus || null,
      effortActual: effortActual || null,
      // What the user asked for, before any per-model clamp.
      requestedEffort: lastRequestedEffort,
      // 'known' | 'unknown' | 'absent'. Only 'unknown' means Notion picked a
      // model outside our catalogue (effort sent unclamped); 'absent' means the
      // request carried no model field at all, which is not a problem.
      modelState: lastModelState,
      swaps: swappedCount,
    }, '*');
  }

  /** True when the model is empty of a known catalogue or explicitly listed. */
  function isKnownModel(model) {
    if (!settings.knownModels || !settings.knownModels.length) return true;
    return settings.knownModels.indexOf(model) !== -1;
  }

  const AUTO_MODEL = /^(auto|default)$/i;
  // Where the model has been seen in the request, most specific first. The new
  // menu is not guaranteed to keep using config.value.model, and a model sent
  // as an object ({ id, name }) must not read as "no model".
  const REQUEST_MODEL_KEYS = ['model', 'modelId', 'model_id', 'selectedModel', 'modelOverride', 'modelName'];

  function modelIdOf(v) {
    if (typeof v === 'string') return v || null;
    if (v && typeof v === 'object') {
      for (const k of ['model', 'id', 'modelId', 'codename', 'value']) {
        if (typeof v[k] === 'string' && v[k]) return v[k];
      }
    }
    return null;
  }

  /** { id, path } of the model this request asks for, or null. */
  function resolveRequestModel(configValue, body) {
    if (configValue) {
      for (const key of REQUEST_MODEL_KEYS) {
        const id = modelIdOf(configValue[key]);
        if (id) return { id: id, path: 'transcript[config].value.' + key };
      }
    }
    // Last resort: any model-ish field anywhere in the body, but only a
    // catalogue id counts — a bare string under "model" could be anything.
    const known = settings.knownModels || [];
    if (!known.length) return null;
    const fields = [];
    collectModelCandidates(body, '', fields, 0);
    const found = fields.find((f) => known.indexOf(f.value) !== -1);
    return found ? { id: found.value, path: found.path } : null;
  }

  function modelStateOf(id) {
    if (!id) return 'absent';
    if (AUTO_MODEL.test(id)) return 'auto';
    return isKnownModel(id) ? 'known' : 'unknown';
  }

  // Keys that enumerate what the workspace *could* run. A hit here says nothing
  // about what actually ran, so it must never drive a verdict.
  const CATALOGUE_KEY = /(models|options|available|allowed|supported|catalog|list|choices)/i;

  // Configuration echoed back — what the account prefers, not what just ran.
  const PREFERENCE_KEY = /(default|prefer|setting|fallback|recommend|suggest|placeholder)/i;

  /**
   * Collect every string that a model-ish key points at, remembering the path
   * so a verdict can be explained (and audited) instead of just asserted.
   */
  function collectModelCandidates(value, path, out, depth, keyRe) {
    const re = keyRe || /model/i;
    if (depth > 8 || value === null || typeof value !== 'object') return;

    if (Array.isArray(value)) {
      // An array under a model-ish key is a catalogue, not an answer.
      for (let i = 0; i < value.length; i++) {
        collectModelCandidates(value[i], path + '[' + i + ']', out, depth + 1, re);
      }
      return;
    }

    for (const key of Object.keys(value)) {
      const child = value[key];
      const childPath = path ? path + '.' + key : key;

      if (typeof child === 'string' && re.test(key) && child && child.length < 64) {
        out.push({
          path: childPath,
          value: child,
          // Path-wide test: a model id nested anywhere under settings or a
          // list is describing configuration, not this run.
          catalogue:
            CATALOGUE_KEY.test(key) ||
            CATALOGUE_KEY.test(path) ||
            PREFERENCE_KEY.test(key) ||
            PREFERENCE_KEY.test(path) ||
            /\[\d+\]/.test(path),
        });
      }
      collectModelCandidates(child, childPath, out, depth + 1, re);
    }
  }

  function plainField(f) {
    return { path: f.path, value: f.value };
  }

  const EFFORT_KEY = /effort|reasoning|thinking|budget/i;
  const EFFORT_VALUES = ['low', 'medium', 'high', 'max'];

  function collectEffortCandidates(value, path, out, depth) {
    collectModelCandidates(value, path, out, depth, EFFORT_KEY);
  }

  /**
   * Turn candidates into a verdict. Deliberately conservative: anything
   * ambiguous degrades to "no evidence" rather than accusing the server of a
   * swap, because a false mismatch is worse than an honest unknown.
   */
  function judgeCandidates(candidates, sentModel, knownValues) {
    const known = knownValues || settings.knownModels || [];
    const usable = candidates.filter((c) => {
      if (c.catalogue) return false;
      if (AUTO_MODEL.test(c.value)) return false;
      // With a catalogue available, only ids we recognise count as identity —
      // plus the id the request itself carried, so a model newer than the
      // catalogue can still be confirmed instead of silently ignored.
      return known.length === 0 || known.indexOf(c.value) !== -1 || (!!sentModel && c.value === sentModel);
    });

    const distinct = [];
    for (const c of usable) {
      if (distinct.indexOf(c.value) === -1) distinct.push(c.value);
    }

    if (distinct.length === 0) return { status: 'unverified', actual: null, paths: [] };
    // Several different ids outside a catalogue key: cannot tell which ran, and
    // the conflicting set travels on so the picker can say so out loud.
    if (distinct.length > 1) {
      return { status: 'unverified', actual: null, paths: [], conflicting: distinct };
    }

    // How many independent places in the payload name this id. One mention is a
    // hint that a stray field could explain; several agreeing mentions are much
    // harder to explain away, so the count is kept rather than discarded.
    const paths = usable.filter((c) => c.value === distinct[0]).map((c) => c.path);

    if (distinct[0] === sentModel) {
      return { status: 'verified', actual: distinct[0], paths: paths };
    }
    return { status: 'mismatch', actual: distinct[0], paths: paths };
  }

  /**
   * Read a copy of the stream so the page still gets the original untouched,
   * and report whether the server named a model back to us. Silence here means
   * "no evidence either way", never "confirmed".
   */
  async function verifyResponseModel(response, sentModel, sentEffort, observeOnly) {
    let copy;
    try {
      copy = response.clone();
    } catch (e) {
      return;
    }

    try {
      const text = await copy.text();
      const candidates = [];
      const effortCandidates = [];

      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (e) {
          continue;
        }
        collectModelCandidates(parsed, '', candidates, 0);
        collectEffortCandidates(parsed, '', effortCandidates, 0);
      }

      // Effort is judged separately: the server can honour the model and still
      // drop reasoningEffort, and that combination must not read as success.
      const effortVerdict = sentEffort
        ? judgeCandidates(effortCandidates, sentEffort, EFFORT_VALUES)
        : { status: 'unverified', actual: null };

      // Without a swap there is nothing to contradict, so the server's choice
      // is reported as an observation rather than judged against an intent.
      const verdict = observeOnly
        ? (function () {
            const seen = judgeCandidates(candidates, sentModel);
            // Carry the supporting paths through: they are the whole basis for
            // the confidence shown later, and rebuilding the verdict object
            // without them would silently reduce it to a bare assertion.
            return seen.actual
              ? { status: 'observed', actual: seen.actual, paths: seen.paths }
              : { status: 'unverified', actual: null, paths: [], conflicting: seen.conflicting };
          })()
        : judgeCandidates(candidates, sentModel);

      // Keep the evidence inspectable: any verdict here is a heuristic over an
      // undocumented payload, so it must be auditable rather than trusted.
      const prev = window.__notionEffortDebug || {};

      // Corroboration across independent sources. The response naming a model
      // is one source; the request carrying the same id is a second, unrelated
      // one. Agreement between them is the strongest evidence obtainable while
      // the payload stays undocumented — so it is measured, not assumed.
      const requestModel = prev.incoming ? prev.incoming.model : null;
      const modelEvidence = {
        paths: verdict.paths || [],
        agreeing: (verdict.paths || []).length,
        conflicting: verdict.conflicting || null,
        requestModel: requestModel,
        matchesRequest: !!(requestModel && verdict.actual && requestModel === verdict.actual),
      };

      window.__notionEffortDebug = {
        incoming: prev.incoming || null,
        request: prev.request || null,
        sentModel: sentModel,
        verdict: verdict.status,
        actual: verdict.actual,
        modelEvidence: modelEvidence,
        candidates: candidates,
        sentEffort: sentEffort,
        effortVerdict: effortVerdict.status,
        effortActual: effortVerdict.actual,
        effortCandidates: effortCandidates,
        raw: text.slice(0, 200000),
      };

      notifyApplied(
        sentModel,
        sentEffort,
        verdict.status,
        null,
        verdict.actual,
        effortVerdict.status,
        effortVerdict.actual,
        modelEvidence
      );
    } catch (e) {
      notifyApplied(sentModel, sentEffort, 'unverified');
    }
  }

  // ------------------------------------------------------------ interception
  //
  // The new Notion AI chat no longer reliably goes through
  // fetch('/api/v3/runInferenceTranscript', { body: string }): the endpoint can
  // be renamed, the call can be a Request object with no options, or go via
  // XHR. So instead of one URL, any /api/ POST whose body carries a transcript
  // config (or a reasoningEffort field) is treated as an AI request.

  const AI_URL = /(runInference|inference|agent|assistant|completion|\/ai[\/A-Z_-])/i;
  const AI_BODY = /"transcript"|reasoningEffort|reasoning_effort/;

  // Every AI-looking request, patched or not, so "nothing was sent through
  // fetch" can be told apart from "sent, but in a shape we did not understand".
  const seen = [];
  window.__notionEffortSeen = seen;

  function shortUrl(url) {
    return String(url || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0];
  }

  function noteSeen(url, via, reason) {
    const entry = {
      url: shortUrl(url),
      via: via,
      reason: reason,
      at: new Date().toISOString().slice(11, 19),
    };
    seen.push(entry);
    if (seen.length > 30) seen.shift();
    window.postMessage({
      type: 'NOTION_EFFORT_SEEN',
      url: entry.url,
      via: via,
      reason: reason,
      count: interceptedCount,
    }, '*');
  }

  /**
   * The object whose reasoningEffort gets patched: the transcript's config step
   * wherever it now sits in the body.
   */
  function findConfigStep(node, path, depth) {
    if (!node || typeof node !== 'object' || depth > 8) return null;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const s = node[i];
        if (s && s.type === 'config' && s.value && typeof s.value === 'object') {
          return { obj: s.value, path: path + '[' + i + '].value' };
        }
      }
      for (let i = 0; i < node.length; i++) {
        const f = findConfigStep(node[i], path + '[' + i + ']', depth + 1);
        if (f) return f;
      }
      return null;
    }
    for (const key of Object.keys(node)) {
      const f = findConfigStep(node[key], path ? path + '.' + key : key, depth + 1);
      if (f) return f;
    }
    return null;
  }

  /** Fallback: any object that already carries an effort field. */
  function findEffortHolder(node, path, depth) {
    if (!node || typeof node !== 'object' || depth > 8) return null;
    if (!Array.isArray(node) && ('reasoningEffort' in node || 'reasoning_effort' in node)) {
      return {
        obj: node,
        path: path || '(root)',
        key: 'reasoningEffort' in node ? 'reasoningEffort' : 'reasoning_effort',
      };
    }
    const keys = Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node);
    for (const k of keys) {
      const next = Array.isArray(node) ? path + '[' + k + ']' : path ? path + '.' + k : String(k);
      const f = findEffortHolder(node[k], next, depth + 1);
      if (f) return f;
    }
    return null;
  }

  /**
   * Patch one parsed request body in place. Synchronous so fetch and XHR can
   * share it. Returns null when the body is not something we understand.
   */
  function patchPayload(body) {
    const target = findConfigStep(body, '', 0) || findEffortHolder(body, '', 0);
    if (!target) return null;
    const cfg = target.obj;
    const effortKey = target.key || 'reasoningEffort';

    // Snapshot what Notion itself sent, before we touch anything. The server
    // never echoes the effort back, so comparing our request against a
    // genuine untouched one is the only evidence left that we are pulling the
    // same lever the native UI pulls.
    const reqModel = resolveRequestModel(cfg, body);
    const incoming = {
      path: target.path,
      model: reqModel ? reqModel.id : null,
      modelPath: reqModel ? reqModel.path : null,
      reasoningEffort: cfg[effortKey] || null,
      effortFields: (function () {
        const f = [];
        collectEffortCandidates(body, '', f, 0);
        return f.map(plainField);
      })(),
    };

    // Whatever model Notion's own menu picked is the model that runs.
    const activeModel = reqModel ? reqModel.id : null;
    const requestedEffort = settings.effort;
    let clampedFrom = null;
    let modified = false;

    // Safety net: if Notion moved to a model we have never seen, we have no
    // effort ceiling for it, so the clamp below is skipped and the ask goes
    // out as-is. Distinguish an absent model field (nothing to clamp, not a
    // problem) and "Auto" (server picks) from a present-but-unfamiliar id
    // (worth flagging) so the picker does not cry wolf.
    lastModelState = modelStateOf(activeModel);
    lastRequestedEffort = requestedEffort;

    // Asking for an effort a model does not offer risks a rejected request,
    // so it is lowered to that model's ceiling instead of sent blindly.
    const supported = settings.effortsByModel[activeModel];
    let targetEffort = requestedEffort;
    if (requestedEffort && Array.isArray(supported)) {
      targetEffort = nearestEffort(requestedEffort, supported);
      if (targetEffort !== requestedEffort) clampedFrom = requestedEffort;
    }

    if (targetEffort && cfg[effortKey] !== targetEffort) {
      cfg[effortKey] = targetEffort;
      modified = true;
    }

    // Only meaningful on the classic config step; not invented on some other
    // object that merely happens to hold an effort field.
    if (settings.maxIntelligence && !target.key) {
      if (cfg.useContextualCoreDocsAutoLoad !== true) {
        cfg.useContextualCoreDocsAutoLoad = true;
        modified = true;
      }
      if (cfg.useDocPreviewsForCoreAutoLoad !== true) {
        cfg.useDocPreviewsForCoreAutoLoad = true;
        modified = true;
      }
    }

    const sentModel = activeModel;
    const sentEffort = cfg[effortKey] || null;

    if (!modified) {
      window.__notionEffortDebug = { incoming: incoming, request: null };
      return { modified: false, sentModel: sentModel, sentEffort: null };
    }

    swappedCount++;

    // If the server takes the effort from some other field, that field shows
    // up here unpatched — the difference between "ignored" and "never asked".
    const requestFields = [];
    collectModelCandidates(body, '', requestFields, 0);
    const requestEffortFields = [];
    collectEffortCandidates(body, '', requestEffortFields, 0);

    // Several Notion model ids carry the effort as a suffix
    // ("...-high", "...-medium"), so the id may be the real effort lever
    // and reasoningEffort merely decorative. Surface both to tell them apart.
    const suffix = /-(low|medium|high|max)$/.exec(sentModel || '');
    window.__notionEffortDebug = {
      incoming: incoming,
      request: {
        patchedPath: target.path + '.' + effortKey,
        sentModel: sentModel,
        modelPath: reqModel ? reqModel.path : null,
        sentEffort: sentEffort,
        requestedEffort: requestedEffort,
        clampedFrom: clampedFrom,
        // 'known' | 'unknown' | 'absent' | 'auto'. 'unknown' => model outside
        // our catalogue, so no effort ceiling could be applied.
        modelState: lastModelState,
        modelFields: requestFields.map(plainField),
        stale: requestFields.filter((f) => f.value !== sentModel).map(plainField),
        effortFields: requestEffortFields.map(plainField),
        effortInModelId: suffix ? suffix[1] : null,
      },
    };
    return { modified: true, sentModel: sentModel, sentEffort: sentEffort };
  }

  function urlOf(input) {
    if (typeof input === 'string') return input;
    if (input instanceof Request) return input.url;
    if (input && typeof input.href === 'string') return input.href;
    return '';
  }

  async function readBody(input, options) {
    if (options && options.body != null) {
      return typeof options.body === 'string' ? options.body : null;
    }
    if (input instanceof Request && input.method !== 'GET' && input.method !== 'HEAD') {
      try {
        return await input.clone().text();
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  const originalFetch = window.fetch;
  // Agent-chat traffic never carries a patchable config: pass it straight
  // through instead of buffering and re-parsing every poll and stream.
  const AGENT_PASS_URL = /\/api\/v3\/(?!runInference)(\w*AgentThread|\w*AgentService|\w*ThreadTranscript|\w*InferenceTranscripts?\w*|getAgent\w*|getThreadSpaceId)/;
  window.fetch = async function (...args) {
    const [input, options] = args;
    const url = urlOf(input);
    if (url.indexOf('/api/') === -1 || AGENT_PASS_URL.test(url)) return originalFetch.apply(this, args);

    const method = String(
      (options && options.method) || (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    if (method !== 'POST') return originalFetch.apply(this, args);

    let text = null;
    try {
      text = await readBody(input, options);
    } catch (e) {}

    const aiUrl = AI_URL.test(url);
    if (!text || text.length > 8000000 || !(aiUrl || AI_BODY.test(text))) {
      if (aiUrl) noteSeen(url, 'fetch', text ? 'body too large' : 'body not readable (not a string)');
      return originalFetch.apply(this, args);
    }

    interceptedCount++;

    let body;
    let result;
    try {
      body = JSON.parse(text);
      result = patchPayload(body);
    } catch (e) {
      noteSeen(url, 'fetch', 'body is not JSON');
      return originalFetch.apply(this, args);
    }

    if (!result) {
      noteSeen(url, 'fetch', 'no config / reasoningEffort in body');
      return originalFetch.apply(this, args);
    }
    noteSeen(url, 'fetch', result.modified ? 'patched' : 'already matched');

    if (!result.modified) {
      // No swap (Auto, or the body already matched). Still read the answer so
      // a server-side allowlist can be tested with the extension standing down.
      const passthrough = await originalFetch.apply(this, args);
      if (passthrough.ok) verifyResponseModel(passthrough, result.sentModel, null, true);
      return passthrough;
    }

    const newText = JSON.stringify(body);
    notifyApplied(result.sentModel, result.sentEffort, 'pending');

    const response = await (input instanceof Request
      ? originalFetch(new Request(input, Object.assign({}, options || {}, { body: newText })))
      : originalFetch(input, Object.assign({}, options, { body: newText })));

    notifyApplied(
      result.sentModel,
      result.sentEffort,
      response.ok ? 'ok' : 'error',
      response.ok ? null : response.status
    );
    if (response.ok) {
      // The model came from Notion, not from us, so it can only be observed
      // — judging it as ours would credit the extension for someone else's
      // choice, which is exactly the lie this rewrite removes.
      verifyResponseModel(response, result.sentModel, result.sentEffort, true);
    }
    return response;
  };

  // XHR path: same patch, applied synchronously to the outgoing body. The
  // response is not re-read here; the footer reports what was sent.
  const rawXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__effortMethod = String(method || 'GET').toUpperCase();
    this.__effortUrl = String(url || '');
    return rawXhrOpen.call(this, method, url, ...rest);
  };

  const rawXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (data) {
    try {
      const url = this.__effortUrl || '';
      if (
        this.__effortMethod === 'POST' &&
        url.indexOf('/api/') !== -1 &&
        typeof data === 'string' &&
        data.length < 8000000 &&
        (AI_URL.test(url) || AI_BODY.test(data))
      ) {
        interceptedCount++;
        const body = JSON.parse(data);
        const result = patchPayload(body);
        noteSeen(
          url,
          'xhr',
          !result ? 'no config / reasoningEffort in body' : result.modified ? 'patched' : 'already matched'
        );
        if (result && result.modified) {
          data = JSON.stringify(body);
          notifyApplied(result.sentModel, result.sentEffort, 'pending');
          const xhr = this;
          xhr.addEventListener('loadend', () => {
            const ok = xhr.status >= 200 && xhr.status < 300;
            notifyApplied(result.sentModel, result.sentEffort, ok ? 'ok' : 'error', ok ? null : xhr.status);
          });
        }
      }
    } catch (e) {}
    try {
      const url = this.__effortUrl || '';
      if (url.indexOf('/api/') !== -1 && typeof data === 'string') {
        const xhr = this;
        noteModelSetting(url.replace(location.origin, ''), data, new Promise((resolve) => {
          xhr.addEventListener('loadend', () => resolve({
            status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300,
            clone: () => ({ text: () => Promise.resolve(String(xhr.responseText || '')) }),
          }));
        }), 'xhr');
      }
    } catch (e) {}
    return rawXhrSend.call(this, data);
  };

  // ---- New agent chat: read the model the server actually assigned ---------
  //
  // The new chat (createAgentThread / sendEventToAgentThread) sends no model
  // and no effort: the server resolves them from the workspace policy and
  // stores the result on the thread record as data.agent_provider
  // { model, modelSelection, reasoningEffort }. Watch the responses that carry
  // thread records and report what the server chose for the open thread.

  const AGENT_RECORD_URL = /\/api\/v3\/(syncRecordValues|createAgentThread|getInferenceTranscriptsForUser|sendEventToAgentThread|getThreadTranscript)/;
  const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
  const agentThreads = {};
  window.__notionEffortAgent = agentThreads;
  // The thread this tab last sent a message to. List responses carry many
  // thread records, so "the last one parsed" would name some old chat.
  let activeThreadKey = null;

  function plainId(id) {
    return String(id || '').replace(/-/g, '').toLowerCase();
  }

  function findAgentProviders(node, uuidKey, depth, out) {
    if (!node || typeof node !== 'object' || depth > 14) return;
    if (!Array.isArray(node) && node.data && node.data.agent_provider && typeof node.data.agent_provider === 'object') {
      out.push({ thread: node.id || uuidKey || null, p: node.data.agent_provider });
    }
    const keys = Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node);
    for (const k of keys) {
      findAgentProviders(node[k], typeof k === 'string' && UUID.test(k) ? k : uuidKey, depth + 1, out);
    }
  }

  function openThreadKey() {
    try {
      const t = new URLSearchParams(location.search).get('t');
      if (t) return plainId(t);
    } catch (e) {}
    return null;
  }

  function publishAgent() {
    const key = openThreadKey();
    const info = (key && agentThreads[key]) || (!key && activeThreadKey && agentThreads[activeThreadKey]);
    if (!info) return;
    window.postMessage(Object.assign({ type: 'NOTION_EFFORT_AGENT' }, info), '*');
  }

  function watchAgentResponse(response) {
    if (!response || !response.ok) return Promise.resolve();
    return response.clone().text().then((text) => {
      if (text.indexOf('agent_provider') === -1) return;
      const found = [];
      findAgentProviders(JSON.parse(text), null, 0, found);
      found.forEach((f) => {
        if (!f.p.model && !f.p.reasoningEffort) return;
        const key = plainId(f.thread || 'unknown');
        agentThreads[key] = {
          thread: f.thread,
          model: f.p.model || null,
          modelSelection: f.p.modelSelection || null,
          reasoningEffort: f.p.reasoningEffort || null,
        };
      });
      if (found.length) publishAgent();
    }).catch(() => {});
  }

  // ---- Agent effort lever ------------------------------------------------
  //
  // space_view.settings.personal_agent_model_preference looked like the lever,
  // but on trials the server ignores it: with { albuquerque-quinn, max } saved,
  // new threads still came back auto / medium. It is only read for diagnostics.
  // The write goes to the thread record itself instead (ensureThreadEffort).

  const PREF_URL = /\/api\/v3\/(getSpaces|syncRecordValues|loadUserContent|getBacklinksForBlock|getUserHomePages)/;
  const AGENT_SEND_URL = /\/api\/v3\/(createAgentThread|sendEventToAgentThread)$/;
  const agentPrefs = {}; // plain spaceId -> { spaceViewId, spaceId, pref }
  window.__notionEffortAgentPrefs = agentPrefs;

  function unwrapRecord(r) {
    for (let i = 0; i < 3 && r && r.value && typeof r.value === 'object' && !r.id; i++) r = r.value;
    return r;
  }

  function findSpaceViews(node, depth) {
    if (!node || typeof node !== 'object' || depth > 10) return;
    if (!Array.isArray(node) && node.space_view && typeof node.space_view === 'object') {
      Object.keys(node.space_view).forEach((k) => {
        const v = unwrapRecord(node.space_view[k]);
        if (!v || !v.id || !v.space_id) return;
        const pref = v.settings && v.settings.personal_agent_model_preference;
        const key = plainId(v.space_id);
        const prev = agentPrefs[key];
        // Keep the view that already carries a preference over a bare one.
        if (prev && prev.pref && !pref) return;
        agentPrefs[key] = { spaceViewId: v.id, spaceId: v.space_id, pref: pref || null };
      });
    }
    const keys = Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node);
    for (const k of keys) findSpaceViews(node[k], depth + 1);
  }

  function watchPrefResponse(response) {
    if (!response || !response.ok) return;
    response.clone().text().then((text) => {
      const hasView = text.indexOf('space_view') !== -1;
      const hasSpace = text.indexOf('"space"') !== -1;
      if (!hasView && !hasSpace) return;
      const json = JSON.parse(text);
      if (hasView) findSpaceViews(json, 0);
      if (hasSpace) findSpaceModelSettings(json, 0);
    }).catch(() => {});
  }

  // Model-related fields of space records (Settings > Notion AI > Model
  // controls lives somewhere in here), for the diagnostics.
  const spaceModelSettings = {}; // plain spaceId -> { field: value }
  const MODEL_FIELD = /model|agent|(^|_)ai(_|$)|^ai[A-Z]/i;

  function pickModelFields(obj, prefix, out, depth) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth > 3) return;
    Object.keys(obj).forEach((k) => {
      const v = obj[k];
      if (MODEL_FIELD.test(k)) out[prefix + k] = JSON.stringify(v).slice(0, 1500);
      else if (v && typeof v === 'object' && !Array.isArray(v)) pickModelFields(v, prefix + k + '.', out, depth + 1);
    });
  }

  function findSpaceModelSettings(node, depth) {
    if (!node || typeof node !== 'object' || depth > 10) return;
    if (!Array.isArray(node) && node.space && typeof node.space === 'object') {
      Object.keys(node.space).forEach((k) => {
        const v = unwrapRecord(node.space[k]);
        if (!v || !v.id) return;
        const out = {};
        pickModelFields(v, '', out, 0);
        if (Object.keys(out).length) spaceModelSettings[plainId(v.id)] = out;
      });
    }
    const keys = Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node);
    for (const k of keys) findSpaceModelSettings(node[k], depth + 1);
  }

  // Notion's full scale; the panel offers low…max. A model that tops out at
  // xhigh (Grok 4.6) gets xhigh for Max: an effort the model does not take
  // makes Notion drop the pick and answer with its default model instead.
  const EFFORT_SCALE = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

  function nearestEffort(wanted, supported) {
    if (!wanted || !Array.isArray(supported) || supported.indexOf(wanted) !== -1) return wanted;
    if (!supported.length) return null;
    const rank = (e) => EFFORT_SCALE.indexOf(e);
    const real = supported.filter((e) => rank(e) > 0).sort((a, b) => rank(a) - rank(b)); // not "none"
    const lower = real.filter((e) => rank(e) <= rank(wanted));
    return lower.length ? lower.pop() : real.length ? real[0] : supported[0];
  }

  function agentTargetEffort(model) {
    return nearestEffort(settings.effort, model && settings.effortsByModel[model]);
  }

  function requestHeaders(input, options) {
    const h = new Headers((options && options.headers) || (input instanceof Request ? input.headers : undefined));
    h.set('content-type', 'application/json');
    return h;
  }

  function reportPref(status, detail) {
    window.__notionEffortAgentPref = Object.assign({ status: status, at: new Date().toISOString() }, detail);
    console.log('[Notion Effort] agent effort preference:', status, detail);
    window.postMessage({ type: 'NOTION_EFFORT_AGENT_PREF', status: status, detail: detail }, '*');
  }

  function dashedId(id) {
    const p = plainId(id);
    return p.length === 32
      ? [p.slice(0, 8), p.slice(8, 12), p.slice(12, 16), p.slice(16, 20), p.slice(20)].join('-')
      : String(id);
  }

  function txPost(input, options, tx) {
    const headers = requestHeaders(input, options);
    const post = (path) => effortFetch(location.origin + path, {
      method: 'POST', credentials: 'include', headers: headers, body: JSON.stringify(tx),
    });
    return post('/api/v3/saveTransactionsFanout')
      .then((res) => (res.status === 404 ? post('/api/v3/saveTransactions') : res));
  }

  // Re-read the thread so the panel shows what the server now holds, not what
  // we hoped to write.
  function rereadThread(input, options, id, spaceId) {
    return effortFetch(location.origin + '/api/v3/syncRecordValues', {
      method: 'POST', credentials: 'include', headers: requestHeaders(input, options),
      body: JSON.stringify({ requests: [{ pointer: { table: 'thread', id: id, spaceId: spaceId }, version: -1 }] }),
    }).then(watchAgentResponse);
  }

  // ---- Per-thread effort ----------------------------------------------------
  //
  // The server stores the effort it runs a chat with on the thread record
  // (data.agent_provider.reasoningEffort). Write the picker's effort there —
  // one field, via update so model/selection stay as the server set them —
  // then re-read the record. If the server resets it, the panel says so.

  // The model is never written to the thread: on the trial the server resets
  // a hand-picked one ("Changed model to Auto", effort lost with it), and with
  // selection left at "auto" the model field is the router's output, rewritten
  // every message. The model goes through the workspace policy instead (below).
  const inflight = {};
  const writeLog = []; // our writes and what the record said afterwards
  const foreignLog = []; // agent_provider writes Notion's own client made
  try { localStorage.removeItem('notionEffortModelStrategy'); localStorage.removeItem('notionEffortChatModelTrial'); } catch (e) {}

  function logPush(list, entry) {
    list.push(entry);
    if (list.length > 12) list.shift();
  }

  function snap(t) {
    return t ? { model: t.model, modelSelection: t.modelSelection, reasoningEffort: t.reasoningEffort } : null;
  }

  function threadOf(bodyText) {
    let body;
    try { body = JSON.parse(bodyText); } catch (e) { return null; }
    const raw = body && (body.threadId || (body.thread && body.thread.id));
    if (!raw || !body.spaceId) return null;
    return { id: dashedId(raw), key: plainId(raw), spaceId: body.spaceId };
  }

  function ensureThreadEffort(input, options, bodyText) {
    const th = threadOf(bodyText);
    if (!th) return Promise.resolve();
    const { id, key, spaceId } = th;
    if (inflight[key]) return inflight[key];
    const thread = agentThreads[key] || {};
    // With a model picked, Auto can only route to it, so clamp to its efforts.
    const effort = agentTargetEffort(settings.model || thread.model);
    if (!effort || thread.reasoningEffort === effort) return Promise.resolve();
    const args = { reasoningEffort: effort };
    const detail = { thread: id, from: thread.reasoningEffort || null, to: effort, model: thread.model || null };
    const tx = (a) => ({
      requestId: crypto.randomUUID(),
      transactions: [{
        id: crypto.randomUUID(),
        spaceId: spaceId,
        debug: { userAction: 'NotionEffort.setThreadConfig' },
        operations: [{
          pointer: { table: 'thread', id: id, spaceId: spaceId },
          path: ['data', 'agent_provider'],
          command: 'update',
          args: a,
        }],
      }],
    });
    const entry = { at: new Date().toISOString(), thread: id, before: snap(thread), args: args };
    logPush(writeLog, entry);
    inflight[key] = (async () => {
      try {
        const res = await txPost(input, options, tx(args));
        entry.http = res.status;
        if (res.ok) {
          swappedCount++;
          trace('effort', 'chat effort ' + (detail.from || 'unset') + ' → ' + detail.to + ' written');
          reportPref('ok', detail);
          await rereadThread(input, options, id, spaceId).catch(() => {});
          entry.after = snap(agentThreads[key]);
        } else {
          trace('effort', 'write FAILED: HTTP ' + res.status);
          reportPref('error', Object.assign({ http: res.status, text: (await res.text()).slice(0, 300) }, detail));
        }
      } catch (e) {
        entry.error = String(e);
        reportPref('error', Object.assign({ error: String(e) }, detail));
      }
    })().finally(() => { inflight[key] = null; });
    return inflight[key];
  }

  // Auto picks the model once the message is in, so look at the record again
  // after the server has had time to act.
  function rereadAfterSend(input, options, bodyText) {
    const th = threadOf(bodyText);
    if (!th) return;
    const sentModel = settings.model;
    const sentAt = Date.now();
    const sentEffort = settings.effort ? agentTargetEffort(settings.model || (agentThreads[th.key] || {}).model) : null;
    [4000, 15000].forEach((ms) => setTimeout(() => {
      rereadThread(input, options, th.id, th.spaceId).then(() => {
        const last = writeLog.filter((w) => w.thread === th.id).pop();
        if (last) last['after' + ms / 1000 + 's'] = snap(agentThreads[th.key]);
        publishAgent();
        reportResult(th, ms, sentModel, sentEffort, sentAt);
      }).catch(() => {});
    }, ms));
  }

  function reportResult(th, ms, sentModel, sentEffort, sentAt) {
    const ag = agentThreads[th.key];
    if (!ag || !ag.model) { trace('result', ms / 1000 + ' s: chat record has no model yet'); return; }
    const okModel = !sentModel || ag.model === sentModel;
    const okEffort = !sentEffort || ag.reasoningEffort === sentEffort;
    trace('result', ms / 1000 + ' s: server ran ' + modelLabel(ag.model) + ' / ' + (ag.reasoningEffort || '?') +
      ' (selection: ' + (ag.modelSelection || '?') + ')' +
      (okModel ? '' : ' ≠ wanted ' + modelLabel(sentModel)) + (okEffort ? '' : ' · effort ≠ ' + sentEffort) +
      (okModel && okEffort ? ' ✓' : ''));
    updateRun(th.key, ms);
    if (!okModel && ms === 4000) {
      explainMismatch(th.spaceId, sentModel, sentEffort, ag.model, sentAt).catch((e) => trace('why', 'could not check: ' + String(e.message || e)));
    }
  }

  // What the server's answer stream says about the model: which one it ran,
  // fallbacks, limits, errors. Only short values under such keys, never the
  // reply text. Read from a copy, so Notion's own reading is untouched.
  const STREAM_KEY = /model|fallback|downgrad|reroute|reason|limit|quota|credit|usage|error|warning|unavailable|disabled|policy|provider|selection|effort/i;
  const STREAM_SKIP = /^(text|content|value|delta|markdown|title)$/i;
  function traceStream(res) {
    let copy;
    try { copy = res.clone(); } catch (e) { return; }
    copy.text().then((text) => {
      const seen = new Set();
      const walk = (v, key, depth) => {
        if (depth > 10 || v == null || seen.size > 40) return;
        if (Array.isArray(v)) { v.slice(0, 50).forEach((x) => walk(x, key, depth + 1)); return; }
        if (typeof v === 'object') {
          Object.keys(v).forEach((k) => { if (!STREAM_SKIP.test(k)) walk(v[k], k, depth + 1); });
          return;
        }
        if (!key || !STREAM_KEY.test(key)) return;
        if (typeof v === 'string' && (v.length > 80 || /\s.*\s.*\s/.test(v) && v.length > 40)) return;
        seen.add(key + '=' + JSON.stringify(v));
      };
      let lines = 0;
      text.split('\n').forEach((line) => {
        const s = line.trim().replace(/^data:\s*/, '');
        if (!s || (s[0] !== '{' && s[0] !== '[')) return;
        lines++;
        try { walk(JSON.parse(s), '', 0); } catch (e) {}
      });
      if (!lines) { try { walk(JSON.parse(text), '', 0); lines = 1; } catch (e) {} }
      trace('stream', lines + ' events · ' + (seen.size ? Array.from(seen).join(', ') : 'no model/limit/error fields'));
    }).catch((e) => trace('stream', 'could not read: ' + String(e.message || e)));
  }

  // Model/effort fields Notion's own client puts in the send (no message
  // text: only short values under keys that name a model or effort).
  function modelFieldsOf(bodyText) {
    const out = [];
    const walk = (v, path, depth) => {
      if (depth > 8 || v == null || out.length > 12) return;
      if (Array.isArray(v)) { v.slice(0, 20).forEach((x, i) => walk(x, path + '[' + i + ']', depth + 1)); return; }
      if (typeof v !== 'object') return;
      Object.keys(v).forEach((k) => {
        const x = v[k];
        const p = path ? path + '.' + k : k;
        if (/model|effort|reason|provider|selection/i.test(k) && (typeof x !== 'object' || x === null)) {
          if (typeof x !== 'string' || x.length <= 60) out.push(p + '=' + JSON.stringify(x));
        } else if (/model|effort|provider|selection/i.test(k) && x && typeof x === 'object') {
          out.push(p + '=' + JSON.stringify(x).slice(0, 120));
        } else {
          walk(x, p, depth + 1);
        }
      });
    };
    try { walk(JSON.parse(bodyText), '', 0); } catch (e) { return 'not JSON'; }
    return out.length ? 'Notion sends ' + out.join(', ') : 'Notion sends no model/effort field';
  }

  // Everything that could make Auto skip the picked model, checked on the server.
  async function explainMismatch(spaceId, model, effort, ran, sentAt) {
    const p = await readPolicy(spaceId);
    trace('why', 'policy right now allows: ' + describePolicy(p, spaceId));
    // Fresh read: the cached catalogue was taken under the previous policy, and
    // restrictedForPersonalAgent there just means "not allowed by that policy".
    catalogue = null;
    const models = await readCatalogue(spaceId).catch((e) => { trace('why', 'catalogue: ' + String(e.message || e)); return []; });
    const m = models.find((x) => x.model === model);
    if (!m) { trace('why', modelLabel(model) + ' is not in this workspace catalogue'); return; }
    const sup = (m.modelConfiguration && m.modelConfiguration.supportedReasoningEfforts) || [];
    const flags = [];
    if (m.isDisabled) flags.push('disabled for this workspace');
    if (m.isDisabledOnlyByDisasterRecovery) flags.push('disabled by Notion (outage)');
    if (m.isApproachingRateLimit) flags.push('near rate limit');
    if (m.restrictedForPersonalAgent) flags.push('restricted for Notion Agent');
    if (isOptIn(model)) flags.push('opt-in model');
    if (effort && sup.length && sup.indexOf(effort) === -1) flags.push('effort ' + effort + ' not supported (' + sup.join(', ') + ')');
    trace('why', modelLabel(model) + ' (fresh catalogue): ' + (flags.length ? flags.join(' · ') : 'no flags'));
    const allowed = models.filter((x) => !x.restrictedForPersonalAgent && !x.isDisabled).map((x) => modelLabel(x.model));
    trace('why', 'catalogue says Notion Agent may use: ' + (allowed.length ? allowed.join(', ') : 'nothing'));
    if (ran && ran !== model) {
      const r = models.find((x) => x.model === ran);
      trace('why', 'the model that ran (' + ran + ') ' + (r
        ? 'is in the catalogue as ' + modelLabel(ran) + (r.restrictedForPersonalAgent ? ', restricted' : '') + (r.isDisabled ? ', disabled' : '')
        : 'is NOT in the catalogue: a server-side fallback, not a model the policy allowed'));
    }
    if (lastPolicyWriteAt && sentAt && sentAt - lastPolicyWriteAt < 5000) {
      trace('why', 'the policy was written only ' + (sentAt - lastPolicyWriteAt) + ' ms before the send (the server may still have used the old list)');
    }
  }

  // Log agent_provider writes Notion's own client makes: if the revert comes
  // from the client rather than the server, this is where it shows up.
  function noteForeignTx(bodyText) {
    if (bodyText.indexOf('agent_provider') === -1 || bodyText.indexOf('NotionEffort.') !== -1) return;
    try {
      const b = JSON.parse(bodyText);
      (b.transactions || []).forEach((t) => (t.operations || []).forEach((op) => {
        if (JSON.stringify(op).indexOf('agent_provider') === -1) return;
        logPush(foreignLog, {
          at: new Date().toISOString(),
          userAction: t.debug && t.debug.userAction,
          table: op.pointer && op.pointer.table, id: op.pointer && op.pointer.id,
          path: op.path, command: op.command, args: op.args,
        });
      }));
    } catch (e) {}
  }

  // ---- Probe: workspace "Allowed models for Notion Agent" ------------------
  //
  // Settings > Notion AI > Model controls restricts which models Notion Agent
  // may use, and Auto respects it. That is the lever for picking a model on a
  // trial, but the request it sends is not known yet: log any API request
  // whose body names a model codename (or looks like a model allowlist) so
  // the format can be read off copy(__notionEffortAgentDiag()).modelSettings.
  const modelSettingLog = [];
  const ALLOW_HINT = /allowed_?models|allowedModels|model_?allow|disabled_?models|model_?restrict/i;

  // Telemetry repeats every experiment name; chat sends carry the user's text.
  const PROBE_SKIP = /etClient|trackEvent|\/log|telemetry|sendEventToAgentThread|createAgentThread|runInference|getCompletion|syncRecordValues|getInferenceTranscripts|getThreadTranscript|listenToThreadTranscript/i;
  const PROBE_URL = /model|aiSetting|ai_setting|agentSetting|allowed|restrict/i;

  function noteModelSetting(path, bodyText, p, via) {
    if (PROBE_SKIP.test(path) || bodyText.indexOf('NotionEffort.') !== -1) return;
    const known = settings.knownModels || [];
    const hit = PROBE_URL.test(path) || ALLOW_HINT.test(bodyText) ||
      known.some((m) => m && bodyText.indexOf('"' + m + '"') !== -1) ||
      (/saveTransactions/.test(path) && /"table":"space"/.test(bodyText) && /model|agent/i.test(bodyText));
    if (!hit) return;
    const entry = { at: new Date().toISOString(), via: via || 'fetch', url: path, body: bodyText.slice(0, 4000) };
    logPush(modelSettingLog, entry);
    console.log('[Notion Effort] model setting request:', path, entry.body);
    p.then((res) => {
      entry.http = res && res.status;
      if (res && res.ok) {
        res.clone().text().then((t) => { entry.response = t.slice(0, 1500); }).catch(() => {});
      }
    }, (e) => { entry.error = String(e); });
  }

  // ---- Model: workspace "Allowed models for Notion Agent" ------------------
  //
  // Auto respects Settings > Notion AI > Model controls > Allowed models for
  // Notion Agent, trial included. That setting is
  // space.settings.personal_agent_model_policy:
  //   { disabledModels: [codename], disabledProviders: ['xai', ...],
  //     allowedRestrictedModels: [codename] }   (restricted = opt-in models)
  // written with updateSpaceSettings { spaceId, settingsPatch, unsetSettingKeys }.
  // Picking a model disables every other one, so Auto can only run the pick;
  // picking Auto puts back the policy the workspace had before, which is kept
  // in localStorage until then. It is workspace-wide, like the setting itself.
  // custom_agent_model_policy (Custom Agents) is left alone.
  const POLICY_KEY = 'personal_agent_model_policy';
  const BACKUP_KEY = 'notionEffortPolicyBackup';
  // Notion routes each workspace to a "cell"; a request carrying another
  // workspace's x-notion-cell / space headers fails with
  // MemcachedCrossCellError. So keep the headers per workspace, as Notion's
  // own requests for that workspace sent them.
  const CELL_HEADER = /^x-notion-(space-id|space-short-id|cell|cell-hint|cell-hint-source)$/;
  const headersBySpace = {}; // plain spaceId -> x-notion-* headers of a request for it
  const baseHeaders = {}; // the rest (client version, active user)
  let lastSpaceId = null; // from request bodies
  let headerSpaceId = null; // from x-notion-space-id
  let agentSpaceId = null; // from chat sends: the workspace this chat is in
  let catalogue = null; // { spaceId, models } from getAvailableModels
  const policyLog = [];
  let policyState = null;
  let policyChain = Promise.resolve();
  let lastPolicyWriteAt = 0;
  let appliedKey = null; // "space|model" last confirmed on the server
  let settingsSeen = false; // the panel's pick has not arrived yet: touch nothing
  // "space|model" (or a bare space for a restore) whose write failed: no
  // retry until the next pick.
  const failed = new Set();

  function noteApiRequest(opts) {
    const h = opts && opts.headers;
    if (h) {
      const got = {};
      const each = (v, k) => { if (/^x-notion-|^notion-/i.test(k)) got[k.toLowerCase()] = String(v); };
      try {
        if (h instanceof Headers) h.forEach(each);
        else if (Array.isArray(h)) h.forEach((kv) => each(kv[1], kv[0]));
        else Object.keys(h).forEach((k) => each(h[k], k));
      } catch (e) {}
      Object.keys(got).forEach((k) => { if (!CELL_HEADER.test(k)) baseHeaders[k] = got[k]; });
      const sid = got['x-notion-space-id'];
      if (sid) {
        headersBySpace[plainId(sid)] = got;
        headerSpaceId = sid;
      }
    }
    if (opts && typeof opts.body === 'string') {
      const m = /"spaceId"\s*:\s*"([0-9a-f-]{32,36})"/i.exec(opts.body);
      if (m) {
        lastSpaceId = dashedId(m[1]);
        setTimeout(loadCatalogueForPicker, 0);
      }
    }
  }

  function currentSpaceId() {
    return agentSpaceId || headerSpaceId || lastSpaceId;
  }

  // Headers of Notion's own request for this workspace; without one, only
  // the workspace id and no cell, and let Notion route it.
  function headersFor(spaceId, bare) {
    const own = !bare && headersBySpace[plainId(spaceId)];
    const h = new Headers(own || Object.assign({}, baseHeaders, { 'x-notion-space-id': dashedId(spaceId) }));
    h.set('content-type', 'application/json');
    return h;
  }

  function apiPost(step, spaceId, path, body) {
    const once = (bare) => effortFetch(location.origin + path, {
      method: 'POST', credentials: 'include', headers: headersFor(spaceId, bare), body: JSON.stringify(body),
    }).then((res) => res.text().then((text) => ({ res: res, text: text })));
    return once(false).then((r) => (!r.res.ok && (/CrossCell/.test(r.text) || r.res.status === 403) ? once(true) : r)).then((r) => {
      if (!r.res.ok) {
        throw Object.assign(new Error(step + ': HTTP ' + r.res.status + ' ' + r.text.slice(0, 200)), { http: r.res.status });
      }
      return JSON.parse(r.text);
    });
  }

  // undefined = the response has no record for this space; null = no policy.
  function findSpacePolicy(json, spaceId) {
    const space = json && json.recordMap && json.recordMap.space;
    if (!space) return undefined;
    const k = Object.keys(space).find((id) => plainId(id) === plainId(spaceId));
    const v = k && unwrapRecord(space[k]);
    if (!v || !v.id) return undefined;
    return (v.settings && v.settings[POLICY_KEY]) || null;
  }

  function readPolicy(spaceId) {
    return apiPost('read policy', spaceId, '/api/v3/syncRecordValues', {
      requests: [{ pointer: { table: 'space', id: spaceId }, version: -1 }],
    }).then((json) => {
      const p = findSpacePolicy(json, spaceId);
      if (p === undefined) throw new Error('space record not returned');
      return p;
    });
  }

  // Without the surface the server answers with an empty list.
  function readCatalogue(spaceId) {
    if (catalogue && catalogue.spaceId === plainId(spaceId)) return Promise.resolve(catalogue.models);
    return apiPost('read models', spaceId, '/api/v3/getAvailableModels', { spaceId: spaceId, surface: 'workspace_model_settings' })
      .then((json) => {
        const models = ((json && json.models) || []).filter((m) => m && m.model);
        if (!models.length) throw new Error('getAvailableModels returned no models');
        // Opt-in models (Fable on a trial, ...). Note restrictedForPersonalAgent
        // is no guide: it is also true for every model the policy disables.
        const optIn = ((json && json.restrictedAccessModelsInPickerConfig) || []).map((r) => r && r.codename).filter(Boolean);
        catalogue = { spaceId: plainId(spaceId), models: models, optIn: optIn };
        publishCatalogue();
        return models;
      });
  }

  const FAMILY_OF = { openai: 'openai', anthropic: 'anthropic', gemini: 'gemini', xai: 'xai' };
  function publishCatalogue() {
    if (!catalogue) return;
    window.postMessage({
      type: 'NOTION_EFFORT_SPACE_MODELS',
      spaceId: catalogue.spaceId,
      models: catalogue.models.map((m) => ({
        model: m.model,
        name: m.modelMessage || m.displayName || m.name || m.model, // modelMessage is the display name
        family: FAMILY_OF[m.modelFamily] || FAMILY_OF[m.modelProvider] || 'mystery',
        efforts: (m.modelConfiguration && m.modelConfiguration.supportedReasoningEfforts) || [],
        optIn: isOptIn(m.model),
      })),
    }, '*');
  }

  // Read-only, for the picker: any workspace id seen will do until a chat
  // send names the real one (the offer is nearly the same everywhere).
  let catalogueLoading = false;
  function loadCatalogueForPicker() {
    const sid = agentSpaceId || currentSpaceId();
    if (catalogue || catalogueLoading || !sid) return;
    catalogueLoading = true;
    readCatalogue(sid).catch(() => {}).then(() => { catalogueLoading = false; });
  }

  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.type === 'NOTION_EFFORT_SPACE_MODELS_REQUEST') {
      if (catalogue) publishCatalogue();
      else loadCatalogueForPicker();
    }
  });

  function loadBackups() {
    try { return JSON.parse(localStorage.getItem(BACKUP_KEY)) || {}; } catch (e) { return {}; }
  }

  function saveBackups(b) {
    try { localStorage.setItem(BACKUP_KEY, JSON.stringify(b)); } catch (e) {}
  }

  const uniq = (a) => Array.from(new Set(a));
  const arr = (v) => (Array.isArray(v) ? v : []);

  function modelLabel(id) {
    if (!id) return 'Auto';
    const m = catalogue && catalogue.models.find((x) => x.model === id);
    return (m && m.modelMessage) || id;
  }

  /** Which models a policy lets Notion Agent use, by name. */
  function describePolicy(p, spaceId) {
    if (!p) return 'every model (no policy)';
    const models = catalogue && catalogue.spaceId === plainId(spaceId) ? catalogue.models : null;
    if (!models) return 'disabled ' + arr(p.disabledModels).length + ' models, ' + arr(p.disabledProviders).length + ' providers';
    const ok = models.filter((m) => arr(p.disabledModels).indexOf(m.model) === -1 &&
      arr(p.disabledProviders).indexOf(m.modelProvider) === -1 &&
      (!isOptIn(m.model) || arr(p.allowedRestrictedModels).indexOf(m.model) !== -1));
    if (!ok.length) return 'nothing';
    if (ok.length === models.length) return 'every model';
    const names = ok.map((m) => m.modelMessage || m.model);
    return names.length > 6 ? names.length + ' models (' + names.slice(0, 6).join(', ') + ', …)' : names.join(', ');
  }

  // Codenames there may lack the effort suffix (acai-budino for acai-budino-high).
  function isOptIn(model) {
    return !!catalogue && (catalogue.optIn || []).some((c) => model === c || model.indexOf(c + '-') === 0);
  }

  // Providers as Notion's own Model controls page names them. The router's
  // fallback (orange-mousse, openai) is not in the catalogue, so disabling it
  // by id does nothing; only switching off its whole provider keeps it out.
  // That is what the settings page does, and why a pick made there sticks.
  // For an OpenAI pick the provider has to stay on, so the fallback is also
  // named in disabledModels even though the catalogue does not list it. If the
  // server refuses or drops an id it does not know, the write is retried
  // without it (see applyPolicy).
  const FALLBACK_IDS = ['orange-mousse'];
  const KNOWN_PROVIDERS = ['anthropic', 'openai', 'gemini', 'xai', 'deepseek', 'kimi', 'glm'];

  function policyFor(model, base, models) {
    const entry = models.find((m) => m.model === model);
    if (!entry) return null;
    const b = base || {};
    // Opt-in (restricted) models are allowed only via allowedRestrictedModels,
    // and the server rejects a model that is both allowed and disabled
    // (ValidationError). So only the pick stays allowed; the catalogue flag
    // reads false for ones already allowed, hence the base list check.
    const restricted = isOptIn(model) || arr(b.allowedRestrictedModels).indexOf(model) !== -1;
    return Object.assign({}, b, {
      disabledModels: uniq(arr(b.disabledModels).concat(models.map((m) => m.model), FALLBACK_IDS)).filter((id) => id !== model),
      disabledProviders: uniq(arr(b.disabledProviders).concat(KNOWN_PROVIDERS, models.map((m) => m.modelProvider).filter(Boolean)))
        .filter((p) => p !== entry.modelProvider),
      allowedRestrictedModels: restricted ? [model] : [],
    });
  }

  function norm(p) {
    if (!p) return 'null';
    const o = {};
    // The server drops empty lists (and nulls) instead of storing them.
    Object.keys(p).sort().forEach((k) => {
      const v = p[k];
      if (v == null || (Array.isArray(v) && !v.length)) return;
      o[k] = Array.isArray(v) ? v.slice().sort() : v;
    });
    return JSON.stringify(o);
  }

  async function applyPolicy(spaceId, model) {
    const sk = plainId(spaceId);
    const backups = loadBackups();
    const has = Object.prototype.hasOwnProperty.call(backups, sk);
    if (!model && !has) return { changed: false }; // Auto, nothing of ours to undo
    const current = await readPolicy(spaceId);
    const where = 'workspace ' + plainId(spaceId).slice(0, 8);
    trace('policy', where + ' now allows: ' + describePolicy(current, spaceId));
    let target;
    if (model) {
      const models = await readCatalogue(spaceId);
      target = policyFor(model, has ? backups[sk] : current, models);
      if (!target) throw new Error(model + ' is not offered in this workspace');
      if (!has) { backups[sk] = current; saveBackups(backups); }
    } else {
      target = backups[sk];
    }
    const done = () => { if (!model) { delete backups[sk]; saveBackups(backups); } };
    if (norm(current) === norm(target)) {
      trace('policy', model ? 'already set for ' + modelLabel(model) + ', no write needed' : where + ': original list already in place');
      done();
      return { changed: false };
    }
    trace('policy', model ? 'writing: allow only ' + modelLabel(model) : where + ': restoring the original list');
    const body = target
      ? { spaceId: spaceId, settingsPatch: { [POLICY_KEY]: target }, unsetSettingKeys: [] }
      : { spaceId: spaceId, settingsPatch: {}, unsetSettingKeys: [POLICY_KEY] };
    const strip = (p) => p && Object.assign({}, p, { disabledModels: arr(p.disabledModels).filter((id) => FALLBACK_IDS.indexOf(id) === -1) });
    const named = target && arr(target.disabledModels).some((id) => FALLBACK_IDS.indexOf(id) !== -1);
    let json;
    try {
      json = await apiPost('write policy', spaceId, '/api/v3/updateSpaceSettings', body);
    } catch (e) {
      if (!named) throw e;
      trace('policy', 'server refused the fallback id ' + FALLBACK_IDS.join(', ') + ' (' + String(e.message || e).slice(0, 80) + '): writing without it');
      target = strip(target);
      body.settingsPatch = { [POLICY_KEY]: target };
      json = await apiPost('write policy', spaceId, '/api/v3/updateSpaceSettings', body);
    }
    const after = findSpacePolicy(json, spaceId);
    if (named && after !== undefined && norm(after) === norm(strip(target)) && norm(after) !== norm(target)) {
      trace('policy', 'server dropped the fallback id ' + FALLBACK_IDS.join(', ') + ': it cannot be switched off by name');
      target = strip(target);
    } else if (named && after !== undefined && norm(after) === norm(target)) {
      trace('policy', 'fallback ' + FALLBACK_IDS.join(', ') + ' switched off by name too');
    }
    if (after !== undefined && norm(after) !== norm(target)) throw new Error('server stored a different policy');
    lastPolicyWriteAt = Date.now();
    trace('policy', 'saved, server now allows: ' + describePolicy(after === undefined ? target : after, spaceId));
    done();
    return { changed: true, allowed: model || null };
  }

  function reportPolicy(status, detail) {
    policyState = Object.assign({ status: status, at: new Date().toISOString() }, detail);
    logPush(policyLog, policyState);
    console.log('[Notion Effort] allowed-models policy:', status, detail);
    window.postMessage({ type: 'NOTION_EFFORT_POLICY', status: status, detail: detail }, '*');
  }

  function hasBackups() {
    return Object.keys(loadBackups()).length > 0;
  }

  // Only the workspace a chat is sent in: any other id seen in traffic may be
  // one of the user's other workspaces (2.9 wrote the policy into one).
  // A backup left in another workspace is put back only once this account is
  // seen using that workspace: the list may hold a workspace of another
  // account or one no longer reachable (403), and trying it there only fails.
  function strayBackups(sid) {
    return Object.keys(loadBackups()).filter((k) => k !== plainId(sid) && !failed.has(k) && headersBySpace[k]);
  }

  // fresh: re-read the server's policy even if this tab set it already. The
  // desktop app or another browser profile may have rewritten it since.
  // ---- Chat tab: which model really answered each message -----------------
  //
  // Every send gets a row: what the workspace allowed at that moment and what
  // the server ran (read from the chat record 4 s and 15 s later). In watch
  // only mode the extension writes nothing at all, so the workspace settings
  // set by hand in Notion are what the server sees.
  const WATCH_KEY = 'notionEffortWatchOnly';
  let watchOnly = false;
  try { watchOnly = localStorage.getItem(WATCH_KEY) === '1'; } catch (e) {}
  const runs = [];
  const runByThread = {};
  function publishRuns() {
    window.postMessage({ type: 'NOTION_EFFORT_RUNS', runs: runs, watchOnly: watchOnly }, '*');
  }
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    if (e.data.type === 'NOTION_EFFORT_RUNS_REQUEST') publishRuns();
    if (e.data.type === 'NOTION_EFFORT_WATCH_ONLY') {
      watchOnly = !!e.data.on;
      try { localStorage.setItem(WATCH_KEY, watchOnly ? '1' : '0'); } catch (x) {}
      trace('watch', watchOnly
        ? 'watch only ON: the extension changes nothing (workspace list, chat model, effort are left to Notion)'
        : 'watch only OFF: the panel picks apply again');
      publishRuns();
    }
  });

  function policyAllows(p, m) {
    if (!p) return true;
    if (arr(p.disabledModels).indexOf(m.model) !== -1) return false;
    if (arr(p.disabledProviders).indexOf(m.modelProvider) !== -1) return false;
    return !isOptIn(m.model) || arr(p.allowedRestrictedModels).indexOf(m.model) !== -1;
  }

  function startRun(bodyText, isNew, after) {
    const th = threadOf(bodyText);
    if (!th) return;
    const run = {
      at: new Date().toISOString(), thread: th.key, isNew: isNew,
      watchOnly: watchOnly, picked: watchOnly ? null : settings.model,
      allowed: '…', allowedIds: null, ran: null, ranName: null, effort: null, selection: null, inList: null, checks: 0,
    };
    runs.push(run);
    if (runs.length > 30) runs.shift();
    runByThread[th.key] = run;
    publishRuns();
    // Read in parallel: the send is not held up.
    // After our own policy write (if any), so the list shown is what the server had.
    Promise.resolve(after).then(() => Promise.all([readPolicy(th.spaceId), readCatalogue(th.spaceId).catch(() => [])])).then(([p, models]) => {
      run.allowed = describePolicy(p, th.spaceId);
      if (models.length) run.allowedIds = models.filter((m) => policyAllows(p, m)).map((m) => m.model);
      finishRun(run);
    }).catch((e) => { run.allowed = 'could not read: ' + String(e.message || e).slice(0, 120); publishRuns(); });
    return { th: th, run: run };
  }

  function finishRun(run) {
    if (run.ran && run.allowedIds) run.inList = run.allowedIds.indexOf(run.ran) !== -1;
    publishRuns();
  }

  function updateRun(key, ms) {
    const run = runByThread[key];
    const ag = agentThreads[key];
    if (!run || !ag || !ag.model) return;
    run.ran = ag.model;
    run.ranName = modelLabel(ag.model);
    run.effort = ag.reasoningEffort || null;
    run.selection = ag.modelSelection || null;
    run.checks = ms / 1000;
    finishRun(run);
    if (ms === 4000) {
      trace('chat', 'answered by ' + run.ranName + (run.ranName !== ag.model ? ' (' + ag.model + ')' : '') +
        ' / ' + (run.effort || '?') + ' · workspace allowed: ' + run.allowed +
        (run.inList === false ? ' · NOT in that list' : run.inList ? ' · in that list ✓' : ''));
    }
  }

  // Watch only (or nothing picked): pass the send through untouched, then look.
  function watchSend(self, args, opts, isNew) {
    const started = startRun(opts.body, isNew);
    const p = effortFetch.apply(self, args);
    p.then((res) => {
      if (!res || !res.ok || !started) return;
      traceStream(res);
      [4000, 15000].forEach((ms) => setTimeout(() => {
        rereadThread(args[0], opts, started.th.id, started.th.spaceId)
          .then(() => { publishAgent(); updateRun(started.th.key, ms); }).catch(() => {});
      }, ms));
    }, () => {});
    return p;
  }

  function ensurePolicy(spaceId, fresh) {
    if (watchOnly) return Promise.resolve();
    const sid = spaceId || agentSpaceId;
    if (!sid || !settingsSeen) {
      if (fresh) trace('policy', !sid ? 'skipped: workspace not known yet' : 'skipped: panel settings not loaded yet');
      return Promise.resolve();
    }
    const want = plainId(sid) + '|' + (settings.model || '');
    if (!fresh && (want === appliedKey || failed.has(want)) && !strayBackups(sid).length) return Promise.resolve();
    policyChain = policyChain.catch(() => {}).then(async () => {
      for (const k of strayBackups(sid)) {
        const other = dashedId(k);
        reportPolicy('pending', { model: null, spaceId: other, restore: true });
        try {
          const r = await applyPolicy(other, null);
          reportPolicy('ok', Object.assign({ model: null, spaceId: other, restore: true }, r));
        } catch (e) {
          failed.add(k);
          reportPolicy('error', { model: null, spaceId: other, restore: true, error: policyError(e), http: e && e.http });
        }
      }
      const model = settings.model;
      const key = plainId(sid) + '|' + (model || '');
      if (failed.has(key)) {
        if (fresh) trace('policy', 'skipped: the last write here failed (' + ((policyState && policyState.error) || 'error') + '); pick again to retry');
        return;
      }
      if (key === appliedKey && !fresh) return;
      if (!model && !Object.prototype.hasOwnProperty.call(loadBackups(), plainId(sid))) {
        if (fresh) trace('policy', 'Auto: workspace list left as it is');
        return;
      }
      reportPolicy('pending', { model: model, spaceId: sid });
      return applyPolicy(sid, model).then((r) => {
        appliedKey = key;
        reportPolicy('ok', Object.assign({ model: model, spaceId: sid }, r));
      }, (e) => {
        failed.add(key);
        trace('policy', 'FAILED: ' + policyError(e));
        reportPolicy('error', { model: model, spaceId: sid, error: policyError(e), http: e && e.http });
      });
    });
    return policyChain;
  }

  function policyError(e) {
    const text = String((e && e.message) || e);
    if (e && e.http === 403) return 'no rights to change workspace settings here (403: only workspace owners can)';
    return text;
  }

  // The settings listener at the top has already stored the new pick.
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.type === 'NOTION_EFFORT_SETTINGS') {
      settingsSeen = true;
      failed.clear(); // a new pick: try again
      if (!watchOnly) ensurePolicy();
    }
  });

  const TIMED_OUT = {};
  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((r) => setTimeout(() => r(TIMED_OUT), ms))]);
  }

  const effortFetch = window.fetch;
  window.fetch = function (...args) {
    let url = '';
    try { url = urlOf(args[0]); } catch (e) {}
    const opts = args[1];
    const watch = (p) => {
      if (AGENT_RECORD_URL.test(url)) p.then(watchAgentResponse, () => {});
      if (PREF_URL.test(url)) p.then(watchPrefResponse, () => {});
      return p;
    };
    if (AGENT_SEND_URL.test(url.split('?')[0]) && opts && typeof opts.body === 'string') {
      try {
        const b = JSON.parse(opts.body);
        const t = b.threadId || (b.thread && b.thread.id);
        if (t) activeThreadKey = plainId(t);
        if (b.spaceId) agentSpaceId = dashedId(b.spaceId);
      } catch (e) {}
    }
    const path = url.split('?')[0];
    if (/\/api\/v3\//.test(path) && opts) noteApiRequest(opts);
    if (/saveTransactions(Fanout)?$/.test(path) && opts && typeof opts.body === 'string') noteForeignTx(opts.body);
    // Chat sends carry the user's text; a codename in there is not a setting.
    if (/\/api\//.test(path) && !PROBE_SKIP.test(path) && opts && typeof opts.body === 'string') {
      const self = this;
      const p = watch(effortFetch.apply(self, args));
      noteModelSetting(path.replace(location.origin, ''), opts.body, p);
      return p;
    }
    // Before the message goes out: the policy (Auto picks the model for this
    // very message) and, on an existing thread, the effort. A new thread's
    // record does not exist until createAgentThread returns, so its effort is
    // written after.
    if (AGENT_SEND_URL.test(path) && opts && typeof opts.body === 'string' &&
        (watchOnly || !(settings.effort || settings.model || hasBackups()))) {
      trace('send', (/createAgentThread$/.test(path) ? 'new chat' : 'chat') + (watchOnly ? ' · watch only: sent as is' : ' · nothing picked: sent as is'));
      return watch(watchSend(this, args, opts, /createAgentThread$/.test(path)));
    }
    if ((settings.effort || settings.model || hasBackups()) && AGENT_SEND_URL.test(path) && opts && typeof opts.body === 'string') {
      const self = this;
      const isNew = /createAgentThread$/.test(path);
      let policyDone;
      const afterPolicy = new Promise((r) => { policyDone = r; });
      startRun(opts.body, isNew, afterPolicy);
      const th = threadOf(opts.body);
      const t0 = Date.now();
      const wantEff = settings.effort
        ? (agentTargetEffort(settings.model || (th && (agentThreads[th.key] || {}).model)) || 'none')
        : "Notion's";
      trace('send', (isNew ? 'new chat' : 'chat ' + (th ? th.key.slice(0, 8) : '?')) +
        ' · want ' + modelLabel(settings.model) + ' / ' + wantEff + ' effort');
      trace('body', modelFieldsOf(opts.body));
      const before = [withTimeout(ensurePolicy(th && th.spaceId, true).catch(() => {}), 4000).then((r) => {
        trace('wait', r === TIMED_OUT
          ? 'policy not confirmed within 4 s: message sent anyway (may run on the old list)'
          : 'policy checked in ' + (Date.now() - t0) + ' ms');
        policyDone();
      })];
      if (!isNew) {
        before.push(withTimeout(ensureThreadEffort(args[0], opts, opts.body)
          .catch((e) => trace('effort', 'chat write error: ' + String(e.message || e))), 4000));
      }
      return Promise.all(before).then(() => {
        const p = watch(effortFetch.apply(self, args));
        p.then((res) => {
          trace('sent', 'Notion answered HTTP ' + (res && res.status));
          if (res) traceStream(res);
          if (!res || !res.ok) return;
          if (isNew) ensureThreadEffort(args[0], opts, opts.body).catch(() => {});
          rereadAfterSend(args[0], opts, opts.body);
        }, () => {});
        return p;
      });
    }
    return watch(effortFetch.apply(this, args));
  };

  // copy(__notionEffortAgentDiag()) — everything the effort lever knows.
  window.__notionEffortAgentDiag = function () {
    return JSON.stringify({
      version: '2.24',
      watchOnly: watchOnly,
      runs: runs,
      url: location.href,
      openThread: openThreadKey(),
      activeThread: activeThreadKey,
      shown: agentThreads[openThreadKey() || activeThreadKey] || null,
      threads: agentThreads,
      prefs: agentPrefs,
      lastSave: window.__notionEffortAgentPref || null,
      wanted: settings.effort,
      wantedModel: settings.model,
      spaceId: agentSpaceId,
      seenSpaceId: currentSpaceId(),
      headerSpaces: Object.keys(headersBySpace),
      headerNames: Object.keys(baseHeaders),
      policy: policyState,
      policyLog: policyLog,
      policyBackup: loadBackups(),
      trace: traceLog.map((t) => t.at.slice(11, 19) + ' ' + t.kind + ' ' + t.text),
      catalogue: catalogue && catalogue.models.map((m) => m.model + '/' + m.modelProvider +
        (m.restrictedForPersonalAgent ? '/restricted' : '') + (m.isDisabled ? '/disabled' : '')),
      catalogueKeys: catalogue && catalogue.models[0] ? Object.keys(catalogue.models[0]) : null,
      writes: writeLog,
      foreign: foreignLog,
      modelSettings: modelSettingLog,
      spaceModelSettings: spaceModelSettings,
    }, null, 2);
  };

  // SPA navigation between chats changes ?t= without a new record fetch.
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    publishAgent();
  }, 1000);
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.type !== 'NOTION_EFFORT_AGENT_REQUEST') return;
    publishAgent();
    if (policyState) window.postMessage({ type: 'NOTION_EFFORT_POLICY', status: policyState.status, detail: policyState }, '*');
  });
})();

