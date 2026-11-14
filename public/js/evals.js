// Evals in the chat: the card an eval suite gets in the conversation, the Evals panel beside
// it, the viewer for one conversation, and the "/" menu in the message box.
//
// A suite is shown the same way in the card and the panel: pick models, press Run evals, and a
// table fills in live with scenarios down and models across. A cell opens that conversation:
// the transcript and the verdict on each criterion. Everything is built with textContent, so
// nothing a model wrote is ever treated as markup.
(function () {
  'use strict';

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function button(text, cls, action) {
    var b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', action);
    return b;
  }
  function api(path, options) {
    return fetch('/api/evals' + path, Object.assign({ headers: { 'Content-Type': 'application/json' }, credentials: 'include' }, options || {})).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok) throw new Error(body.error || 'That did not go through.');
        return body;
      });
    });
  }
  var seconds = function (ms) { return ms == null ? '–' : (ms / 1000).toFixed(ms < 9950 ? 1 : 0) + 's'; };
  var count = function (n) { return n >= 1000000 ? (n / 1000000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(n < 99500 ? 1 : 0) + 'k' : String(n); };
  var when = function (value) {
    var date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
    return isNaN(date) ? '' : date.toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  };
  var plural = function (n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); };
  var STATUS = { passed: 'Pass', failed: 'Fail', error: 'Error', running: 'Running', pending: 'Queued', stopped: 'Not run' };
  var MARK = { passed: '✓', failed: '✕', error: '!' };
  function changed(suiteId, source) { document.dispatchEvent(new CustomEvent('lfg-evals-changed', { detail: { suiteId: suiteId, source: source } })); }

  // ── One conversation: the transcript, and the verdict on each criterion ──
  function openResult(resultId, opener) {
    var modal = el('dialog', 'ca-dialog ev-dialog');
    var head = el('header', 'ca-dialog-head'), heading = el('div', 'ev-dialog-head-text');
    var title = el('strong', null, 'Loading…'), sub = el('small');
    heading.append(title, sub);
    var close = button('×', 'ca-dialog-close', function () { modal.close(); });
    close.title = 'Close'; close.setAttribute('aria-label', 'Close');
    head.append(heading, close);
    var body = el('div', 'ca-dialog-body');
    modal.append(head, body);
    document.body.append(modal);
    modal.addEventListener('close', function () { modal.remove(); if (opener && opener.isConnected) opener.focus(); });
    modal.addEventListener('click', function (event) { if (event.target === modal) modal.close(); });
    modal.showModal();

    api('/results/' + encodeURIComponent(resultId)).then(function (data) {
      var r = data.result, scenario = r.scenario || {}, verdict = r.verdict || {};
      title.textContent = scenario.title || 'Scenario';
      sub.textContent = r.modelLabel;
      modal.setAttribute('aria-label', (scenario.title || 'Scenario') + ' on ' + r.modelLabel);

      var transcript = el('div', 'ev-transcript');
      if (!r.transcript.length) transcript.append(el('p', 'ev-note', r.status === 'error' ? 'The conversation did not start.' : 'No conversation was recorded.'));
      r.transcript.forEach(function (entry) {
        var turn = el('div', 'ev-turn'); turn.dataset.role = entry.role;
        turn.append(el('span', 'ev-turn-who', entry.role === 'agent' ? r.modelLabel + (entry.ms ? ' · ' + seconds(entry.ms) : '') : 'Person (simulated)'));
        (entry.toolCalls || []).forEach(function (call) {
          var row = el('div', 'ev-tool');
          row.append(el('b', null, call.name), document.createTextNode('(' + JSON.stringify(call.input == null ? {} : call.input) + ')\n→ ' + (typeof call.output === 'string' ? call.output : JSON.stringify(call.output))));
          turn.append(row);
        });
        if (entry.text || !(entry.toolCalls || []).length) turn.append(el('div', 'ev-bubble' + (entry.text ? '' : ' is-empty'), entry.text || 'Said nothing'));
        transcript.append(turn);
      });

      var side = el('div', 'ev-verdict');
      var badge = el('span', 'ev-badge', (MARK[r.status] ? MARK[r.status] + ' ' : '') + (STATUS[r.status] || r.status) + (r.score != null && r.status === 'failed' ? ' · ' + r.score + '% of criteria met' : ''));
      badge.dataset.status = r.status;
      side.append(badge);
      if (r.error) { side.append(el('h4', null, 'What went wrong'), el('p', null, r.error)); }
      if (verdict.summary) { side.append(el('h4', null, 'Summary'), el('p', null, verdict.summary)); }
      if ((verdict.criteria || []).length) {
        var list = el('ul', 'ev-criteria');
        verdict.criteria.forEach(function (c) {
          var item = el('li'); item.dataset.pass = String(!!c.pass);
          var text = el('div', null, c.criterion);
          if (c.reason) text.append(el('small', null, c.reason));
          var mark = el('span', null, c.pass ? '✓' : '✕'); mark.setAttribute('aria-label', c.pass ? 'Met' : 'Not met');
          item.append(mark, text); list.append(item);
        });
        side.append(el('h4', null, 'Criteria'), list);
      } else if ((scenario.criteria || []).length && !r.error) {
        var plain = el('ul', 'ev-criteria');
        scenario.criteria.forEach(function (c) { var item = el('li'); item.append(el('span', null, '·'), el('div', null, c)); plain.append(item); });
        side.append(el('h4', null, 'Criteria (not graded)'), plain);
      }
      if (scenario.persona) side.append(el('h4', null, 'The person'), el('p', null, scenario.persona));
      var stats = el('dl', 'ev-stats');
      [['Agent replies', String(r.turns)], ['Average reply', r.latencyMs ? seconds(r.latencyMs) : '–'], ['Tokens', r.inputTokens + r.outputTokens ? count(r.inputTokens) + ' in · ' + count(r.outputTokens) + ' out' : '–']].forEach(function (pair) {
        stats.append(el('dt', null, pair[0]), el('dd', null, pair[1]));
      });
      side.append(el('h4', null, 'Numbers'), stats);
      body.append(transcript, side);
    }).catch(function (error) {
      title.textContent = 'Could not open this conversation';
      body.append(el('p', 'ev-note is-error', error.message));
      body.style.display = 'block'; body.style.padding = '24px';
    });
  }

  // ── One suite: models, Run, results. `full` adds what the suite tests and its past runs. ──
  var views = 0;
  function SuiteView(suiteId, options) {
    this.suiteId = suiteId; this.options = options || {}; this.id = ++views;
    this.root = el('div', 'ev-suite');
    this.data = null; this.error = ''; this.busy = false; this.timer = null; this.picked = null; this.gone = false;
    var self = this;
    this.onChange = function (event) { if (event.detail.suiteId === self.suiteId && event.detail.source !== self.id) self.load(); };
    document.addEventListener('lfg-evals-changed', this.onChange);
    this.root.append(el('p', 'ev-note', 'Loading evals…'));
  }
  SuiteView.prototype.projectKey = function () { return 'lfg-eval-models:' + (this.options.projectId || ''); };
  SuiteView.prototype.destroy = function () { clearTimeout(this.timer); this.timer = null; this.dead = true; document.removeEventListener('lfg-evals-changed', this.onChange); };
  SuiteView.prototype.load = function (runId) {
    var self = this;
    return api('/' + encodeURIComponent(this.suiteId) + (runId ? '?run=' + encodeURIComponent(runId) : '')).then(function (data) {
      self.data = data; self.error = ''; self.gone = false;
      if (!self.picked) {
        var saved = [];
        try { saved = JSON.parse(localStorage.getItem(self.projectKey()) || '[]'); } catch (_) { /* first visit */ }
        var usable = saved.filter(function (key) { return data.models.some(function (m) { return m.key === key; }); });
        self.picked = usable.length ? usable : data.selected ? [data.selected] : [];
      }
      if (self.options.onLoad) self.options.onLoad(data);
      self.paint(); self.watch();
    }).catch(function (error) {
      self.gone = !self.data; self.error = error.message; self.paint();
    });
  };
  /** While a run is going, fetch the grid every moment and repaint the table. */
  SuiteView.prototype.watch = function () {
    var self = this;
    clearTimeout(this.timer); this.timer = null;
    if (this.dead || !this.data || !this.data.run || this.data.run.status !== 'running') return;
    this.timer = setTimeout(function tick() {
      if (self.dead || !self.root.isConnected) { self.timer = null; return; }
      api('/runs/' + encodeURIComponent(self.data.run.id)).then(function (body) {
        self.data.run = body.run; self.paint();
        if (body.run.status === 'running') self.timer = setTimeout(tick, document.hidden ? 6000 : 1500);
        else { self.timer = null; changed(self.suiteId, self.id); }
      }).catch(function () { self.timer = setTimeout(tick, 6000); });
    }, 1200);
  };
  SuiteView.prototype.run = function () {
    var self = this;
    if (this.busy || !this.picked.length) return;
    this.busy = true; this.error = ''; this.paint();
    try { localStorage.setItem(this.projectKey(), JSON.stringify(this.picked)); } catch (_) { /* private mode */ }
    api('/' + encodeURIComponent(this.suiteId) + '/runs', { method: 'POST', body: JSON.stringify({ models: this.picked }) }).then(function (body) {
      self.data.run = body.run;
      self.data.runs = [{ id: body.run.id, status: 'running', createdAt: body.run.createdAt }].concat(self.data.runs || []);
      changed(self.suiteId, self.id);
    }).catch(function (error) { self.error = error.message; }).then(function () { self.busy = false; self.paint(); self.watch(); });
  };
  SuiteView.prototype.stop = function () {
    var self = this;
    api('/runs/' + encodeURIComponent(this.data.run.id) + '/stop', { method: 'POST' }).then(function (body) { self.data.run = body.run; self.paint(); self.watch(); changed(self.suiteId, self.id); })
      .catch(function (error) { self.error = error.message; self.paint(); });
  };
  SuiteView.prototype.toggle = function (key) {
    var at = this.picked.indexOf(key);
    if (at >= 0) this.picked.splice(at, 1); else if (this.picked.length < 6) this.picked.push(key);
    this.paint();
  };

  SuiteView.prototype.table = function (run) {
    var self = this, wrap = el('div', 'ev-table-wrap'), table = el('table', 'ev-table');
    var head = el('tr'); head.append(el('th', null, 'Scenario'));
    run.models.forEach(function (m) { var th = el('th', null, m.label); th.scope = 'col'; head.append(th); });
    var thead = el('thead'); thead.append(head);
    var tbody = el('tbody');
    run.scenarios.forEach(function (scenario) {
      var row = el('tr'); row.append(el('td', null, scenario.title));
      run.models.forEach(function (m) {
        var cell = run.cells.find(function (c) { return c.scenarioId === scenario.id && c.modelKey === m.key; });
        var td = el('td');
        if (cell) {
          var done = cell.status === 'passed' || cell.status === 'failed' || cell.status === 'error';
          var pill = button('', 'ev-cell', function () { openResult(cell.id, pill); });
          pill.dataset.status = cell.status; pill.disabled = !done;
          if (cell.status === 'running') pill.append(el('span', 'ev-spin'));
          pill.append(document.createTextNode((MARK[cell.status] ? MARK[cell.status] + ' ' : '') + STATUS[cell.status]));
          if (cell.status === 'failed' && cell.score != null) pill.append(el('small', null, cell.score + '%'));
          pill.title = done ? (cell.error || cell.summary || 'Open the conversation') : STATUS[cell.status];
          pill.setAttribute('aria-label', scenario.title + ' on ' + m.label + ': ' + STATUS[cell.status] + (done ? '. Open the conversation' : ''));
          td.append(pill);
        }
        row.append(td);
      });
      tbody.append(row);
    });
    var tfoot = el('tfoot');
    [['Passed', function (m) { return m.passed + m.failed ? m.passed + ' of ' + (m.passed + m.failed) + ' · ' + m.passRate + '%' + (m.errors ? ' (' + plural(m.errors, 'error') + ')' : '') : m.errors ? plural(m.errors, 'error') : '–'; }],
      ['Average reply', function (m) { return seconds(m.avgLatencyMs); }],
      ['Tokens used', function (m) { return m.inputTokens + m.outputTokens ? count(m.inputTokens + m.outputTokens) : '–'; }]].forEach(function (line) {
      var row = el('tr'); row.append(el('td', null, line[0]));
      run.models.forEach(function (m) { row.append(el('td', null, line[1](m))); });
      tfoot.append(row);
    });
    table.append(thead, tbody, tfoot); wrap.append(table);
    return wrap;
  };

  SuiteView.prototype.paint = function () {
    var self = this, data = this.data, root = this.root, full = !!this.options.full;
    if (!data) {
      root.replaceChildren(el('p', 'ev-note' + (this.gone ? '' : ' is-error'), this.gone ? 'These evals are no longer available. They may have been deleted.' : this.error || 'Loading evals…'));
      return;
    }
    var run = data.run, running = !!run && run.status === 'running', parts = [];
    if (full && data.suite.description) parts.push(el('p', 'ev-desc', data.suite.description));

    if (data.canRun) {
      var controls = el('div', 'ev-controls');
      if (!data.models.length) controls.append(el('p', 'ev-note', 'No models are available to run evals with. Add an API key in Settings → LLM Keys, or connect your ChatGPT subscription.'));
      else {
        var models = el('div', 'ev-models'); models.setAttribute('role', 'group'); models.setAttribute('aria-label', 'Models to compare');
        models.append(el('span', 'ev-models-label', 'Compare'));
        data.models.forEach(function (m) {
          var chip = button(m.label.replace(/ · Subscription$/, ''), 'ev-chip', function () { self.toggle(m.key); });
          chip.setAttribute('aria-pressed', String(self.picked.indexOf(m.key) >= 0));
          chip.title = m.provider; chip.disabled = running || self.busy;
          models.append(chip);
        });
        var actions = el('div', 'ev-actions');
        if (running) {
          var done = run.cells.filter(function (c) { return c.status !== 'pending' && c.status !== 'running'; }).length;
          var progress = el('div', 'ev-progress'), bar = el('div', 'ev-bar'), fill = el('span');
          fill.style.width = (run.cells.length ? Math.round(100 * done / run.cells.length) : 0) + '%';
          bar.append(fill); bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', String(run.cells.length)); bar.setAttribute('aria-valuenow', String(done));
          progress.append(el('span', null, done + ' of ' + plural(run.cells.length, 'conversation')), bar);
          actions.append(progress, button('Stop', 'ev-quiet', function () { self.stop(); }));
        } else {
          var go = button(this.busy ? 'Starting…' : run ? 'Run again' : 'Run evals', 'ev-run', function () { self.run(); });
          go.disabled = this.busy || !this.picked.length;
          var total = data.suite.scenarios.length * this.picked.length;
          actions.append(go, el('span', 'ev-note', this.picked.length ? plural(data.suite.scenarios.length, 'scenario') + ' × ' + plural(this.picked.length, 'model') + ' = ' + plural(total, 'conversation') : 'Pick at least one model.'));
        }
        controls.append(models, actions);
      }
      parts.push(controls);
    }
    if (this.error) parts.push(el('p', 'ev-note is-error', this.error));

    if (run) {
      parts.push(this.table(run));
      var meta = el('div', 'ev-meta');
      if (full && (data.runs || []).length > 1) {
        var pick = el('select'); pick.setAttribute('aria-label', 'Which run to show');
        data.runs.forEach(function (r, i) { var o = el('option', null, (i === 0 ? 'Latest run · ' : '') + when(r.createdAt)); o.value = r.id; o.selected = r.id === run.id; pick.append(o); });
        pick.addEventListener('change', function () { self.load(pick.value); });
        meta.append(pick);
      } else meta.append(el('span', null, (running ? 'Started ' : run.status === 'stopped' ? 'Stopped · ' : 'Ran ') + when(run.createdAt)));
      if (run.judgeModel) meta.append(el('span', null, '· The person is played and graded by ' + run.judgeModel.replace(/ · Subscription$/, '')));
      if (!running) meta.append(el('span', null, '· Click a result to read the conversation'));
      parts.push(meta);
    } else if (!full) {
      // Not run yet: show what will be tested.
      var preview = el('ol', 'ev-preview');
      data.suite.scenarios.slice(0, 5).forEach(function (s, i) { var li = el('li'); li.append(el('span', null, String(i + 1)), document.createTextNode(s.title)); preview.append(li); });
      if (data.suite.scenarios.length > 5) { var more = el('li', 'ev-more'); more.append(el('span', null, '+'), document.createTextNode((data.suite.scenarios.length - 5) + ' more')); preview.append(more); }
      parts.push(preview);
    } else if (!data.canRun) parts.push(el('p', 'ev-note', 'These evals have not been run yet.'));

    if (full) {
      var scenarios = el('section', 'ev-section'), sh = el('h4', null, 'Scenarios'); sh.append(el('small', null, String(data.suite.scenarios.length)));
      scenarios.append(sh);
      data.suite.scenarios.forEach(function (s) {
        var item = el('details', 'ev-scenario'); item.append(el('summary', null, s.title));
        var inner = el('div');
        if (s.persona) inner.append(el('p', 'ev-label', 'The person'), el('p', null, s.persona));
        if (s.opening) inner.append(el('p', 'ev-label', 'Opens with'), el('p', null, s.opening));
        var list = el('ul'); s.criteria.forEach(function (c) { list.append(el('li', null, c)); });
        inner.append(el('p', 'ev-label', 'Passes when the agent'), list, el('p', 'ev-note', s.maxTurns === 1 ? 'One question, one answer.' : 'Up to ' + s.maxTurns + ' agent replies.'));
        item.append(inner); scenarios.append(item);
      });
      parts.push(scenarios);
      var agent = el('section', 'ev-section'); agent.append(el('h4', null, 'The agent being tested'));
      var prompt = el('details', 'ev-scenario'); prompt.append(el('summary', null, 'Instructions'));
      var promptBody = el('div'); promptBody.append(el('pre', 'ev-pre', data.suite.agentPrompt)); prompt.append(promptBody); agent.append(prompt);
      if (data.suite.tools.length) {
        var tools = el('details', 'ev-scenario'); tools.append(el('summary', null, 'Stand-in tools · ' + data.suite.tools.length));
        var toolsBody = el('div');
        data.suite.tools.forEach(function (t) { toolsBody.append(el('p', 'ev-label', t.name), el('p', null, t.description || 'No description.'), el('pre', 'ev-pre', 'returns ' + t.returns)); });
        tools.append(toolsBody); agent.append(tools);
      }
      parts.push(agent);
      if (data.canEdit && this.options.onDelete) {
        var foot = el('section', 'ev-section'), remove = button('Delete these evals', 'ev-quiet ev-danger', function () {
          if (!window.confirm('Delete "' + data.suite.name + '" and all of its runs? This cannot be undone.')) return;
          remove.disabled = true;
          api('/' + encodeURIComponent(self.suiteId), { method: 'DELETE' }).then(function () { changed(self.suiteId, self.id); self.options.onDelete(); })
            .catch(function (error) { remove.disabled = false; self.error = error.message; self.paint(); });
        });
        foot.append(remove, el('p', 'ev-note', 'To change the scenarios or the instructions, ask in the chat: "add a scenario where the caller speaks Spanish".'));
        foot.lastChild.style.marginTop = '10px';
        parts.push(foot);
      }
    }
    root.replaceChildren.apply(root, parts);
  };

  // ── The card an eval suite gets in the conversation ──
  var cards = new WeakMap();
  function card(m) {
    var existing = cards.get(m.card);
    if (existing) { existing.name.textContent = m.artifact.name; existing.view.load(); return; }
    var head = el('header', 'ca-head'), heading = el('div', 'ca-heading');
    var name = el('strong', null, m.artifact.name), sub = el('small', 'ca-muted', 'Evals');
    heading.append(name, sub);
    head.append(heading, button('Open in panel ↗', null, function () { Panel.open(m.artifact.id); }));
    var body = el('div', 'ev-card-body');
    var view = new SuiteView(m.artifact.id, { projectId: m.projectId, onLoad: function (data) {
      name.textContent = data.suite.name;
      sub.textContent = 'Evals · ' + plural(data.suite.scenarios.length, 'scenario');
    } });
    body.append(view.root);
    m.card.replaceChildren(head, body);
    cards.set(m.card, { view: view, name: name });
    view.load();
  }

  // ── The Evals panel beside the chat: every suite of the project, and one suite in full ──
  var Panel = (function () {
    var root = document.getElementById('evals-root');
    if (!root) return { open: function (id) { /* no panel on this page */ } };
    var projectId = root.getAttribute('data-project-id');
    root.classList.add('ev-panel');
    var head = el('div', 'ev-panel-head');
    var back = button('', 'ev-back', function () { showList(); }); back.title = 'All evals'; back.setAttribute('aria-label', 'All evals');
    back.append(el('i', 'fas fa-arrow-left')); back.hidden = true;
    var title = el('h3', 'ev-panel-title', 'Evals');
    var write = button('Write evals', 'ev-quiet', function () { ask('/evals '); });
    head.append(back, title, write);
    var body = el('div', 'ev-panel-body');
    root.replaceChildren(head, body);
    var current = null, started = false;

    function ask(text) {
      var input = document.getElementById('chat-input');
      if (!input) return;
      input.value = text; input.focus();
      input.setSelectionRange(text.length, text.length);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function level(rate) { return rate == null ? '' : rate >= 90 ? 'good' : rate >= 60 ? 'mixed' : 'bad'; }
    function showList() {
      if (current) { current.destroy(); current = null; }
      back.hidden = true; write.hidden = false; title.textContent = 'Evals';
      body.replaceChildren(el('p', 'ev-note', 'Loading evals…'));
      api('?projectId=' + encodeURIComponent(projectId)).then(function (data) {
        if (current) return;
        write.hidden = !data.canEdit;
        if (!data.suites.length) {
          var empty = el('div', 'ev-empty');
          empty.append(el('p', null, 'Evals check how the AI agent you are building behaves: each scenario is a person to play against it and what it must get right. Run them against several models to see which one handles your agent best.'));
          if (data.canEdit) { var hint = el('p'); hint.append(document.createTextNode('Type '), el('code', null, '/evals'), document.createTextNode(' in the chat and LFG writes a suite from your project.')); empty.append(hint); }
          body.replaceChildren(empty);
          return;
        }
        var list = el('div', 'ev-list');
        data.suites.forEach(function (suite) {
          var item = button('', 'ev-list-item', function () { showSuite(suite.id, suite.name); });
          item.append(el('b', null, suite.name));
          item.append(el('small', null, plural(suite.scenarioCount, 'scenario') + (suite.lastRun ? ' · ' + (suite.lastRun.status === 'running' ? 'running now' : 'last run ' + when(suite.lastRun.createdAt)) : ' · not run yet')));
          if (suite.lastRun && suite.lastRun.models.length) {
            var scores = el('div', 'ev-scores');
            suite.lastRun.models.forEach(function (m) { var s = el('span', 'ev-score', m.label.replace(/ · Subscription$/, '') + ' ' + (m.passRate == null ? '–' : m.passed + '/' + m.total)); s.dataset.level = level(m.passRate); scores.append(s); });
            item.append(scores);
          }
          list.append(item);
        });
        body.replaceChildren(list);
      }).catch(function (error) { body.replaceChildren(el('p', 'ev-note is-error', error.message)); });
    }
    function showSuite(id, name) {
      if (current) current.destroy();
      back.hidden = false; write.hidden = true; title.textContent = name || 'Evals';
      current = new SuiteView(id, { projectId: projectId, full: true, onLoad: function (data) { title.textContent = data.suite.name; }, onDelete: showList });
      body.replaceChildren(current.root);
      current.load();
    }
    function start() { if (!started) { started = true; showList(); } }
    // Nothing is fetched until the tab is first shown; coming back to the list refreshes it.
    var tab = document.querySelector('.tab-button[data-tab="evals"]');
    if (tab) tab.addEventListener('click', function () { if (!started) start(); else if (!current) showList(); });
    var pane = document.getElementById('evals');
    if (pane) new MutationObserver(function () { if (pane.classList.contains('active')) start(); }).observe(pane, { attributes: true, attributeFilter: ['class'] });
    if (pane && pane.classList.contains('active')) start();
    document.addEventListener('lfg-evals-changed', function () { if (started && !current && pane && pane.classList.contains('active')) showList(); });

    return {
      open: function (id) {
        if (window.ArtifactsPanel && window.ArtifactsPanel.open) window.ArtifactsPanel.open();
        if (window.switchTab && pane && !pane.classList.contains('active')) window.switchTab('evals');
        started = true; showSuite(id);
      },
      list: showList,
    };
  })();

  // ── The "/" menu: commands offered while the message is just a slash and a word ──
  (function () {
    var input = document.getElementById('chat-input');
    if (!input || !document.getElementById('evals-root')) return;
    var COMMANDS = [
      { text: '/evals ', name: '/evals', hint: 'Write evals for the AI agent this project is building. Add what to focus on, or just send.' },
      { text: '/evals run', name: '/evals run', hint: 'Run the evals on the model this chat is using.' },
    ];
    var menu = null, shown = [], at = 0;
    function close() { if (menu) { menu.remove(); menu = null; } shown = []; }
    function pick(command) {
      input.value = command.text; close(); input.focus();
      input.setSelectionRange(command.text.length, command.text.length);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function paint() {
      var box = (document.getElementById('chat-input-box') || input).getBoundingClientRect();
      menu.replaceChildren.apply(menu, shown.map(function (command, i) {
        var row = el('button'); row.type = 'button'; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(i === at));
        row.append(el('b', null, command.name), el('small', null, command.hint));
        row.addEventListener('mousedown', function (event) { event.preventDefault(); pick(command); });
        return row;
      }));
      menu.style.left = Math.max(12, box.left) + 'px';
      menu.style.bottom = (window.innerHeight - box.top + 8) + 'px';
    }
    function update() {
      var typed = input.value.toLowerCase().replace(/\s+$/, '');
      // Only while the whole message is a command being typed ("/", "/ev", "/evals r"). A finished command sends on Enter.
      var matches = /^\/[a-z ]*$/.test(typed) && !COMMANDS.some(function (c) { return c.name === typed; }) ? COMMANDS.filter(function (c) { return c.name.indexOf(typed) === 0; }) : [];
      if (!matches.length) { close(); return; }
      shown = matches; at = Math.min(at, shown.length - 1);
      if (!menu) { menu = el('div', 'ev-slash'); menu.setAttribute('role', 'listbox'); menu.setAttribute('aria-label', 'Commands'); document.body.append(menu); at = 0; }
      paint();
    }
    input.addEventListener('input', update);
    input.addEventListener('blur', function () { setTimeout(close, 120); });
    // Ahead of the chat's own Enter handling, so choosing a command does not send the message.
    document.addEventListener('keydown', function (event) {
      if (!menu || event.target !== input) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { at = (at + (event.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length; paint(); }
      else if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) pick(shown[at]);
      else if (event.key === 'Escape') close();
      else return;
      event.preventDefault(); event.stopImmediatePropagation();
    }, true);
  })();

  window.EvalsUI = { card: card, open: Panel.open, openResult: openResult };
})();
