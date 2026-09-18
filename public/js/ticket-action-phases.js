/* Shared by the ticket drawer and the chat ticket panel. No log content is discarded. */
(function (root) {
  function group(rows, ticket) {
    const phases = [{ id: 'build', label: 'Build', status: 'pending', rows: [] }, { id: 'validation', label: 'Validation', status: 'pending', rows: [] }];
    let active = 0;
    let buildStarted = false;
    for (const row of rows) {
      const text = String(row.message || '').replace(/\*\*/g, '').trim();
      const retry = /^Retrying validation of saved commit/i.test(text);
      const validation = retry || /^(Running the saved ticket:|Repairing runtime checks:|Checking:|Preparing validation:|Now verifying this commit|Fresh \/ candidate:|Runtime checks passed|✅\s*Validation passed)/i.test(text);
      const build = /^(Starting Pi build|Isolated build:|Starting (?:ticket )?build|Building ticket)/i.test(text);
      if (build) { buildStarted = true; active = 0; phases[0].status = 'working'; phases[1].status = 'pending'; }
      if (validation) {
        active = 1;
        if (phases[0].status === 'working') phases[0].status = buildStarted ? 'done' : 'unknown';
        if (retry && !phases[0].rows.length) phases[0].status = 'skipped';
        phases[1].status = 'working';
      }
      phases[active].rows.push(row);
      if (phases[active].status === 'pending') phases[active].status = 'working';
      if (/^(Execution failed:|❌|Pi build failed:|Pi build error:)/.test(text)) phases[active].status = 'error';
      if (/^(Runtime checks passed|✅\s*Validation passed|Validation and publication passed)/i.test(text)) phases[1].status = 'done';
      if (/^(Ticket complete|✅\s*(?:Build complete|Implementation complete))/.test(text)) phases[active].status = 'done';
      if (/cancelled|stopped by user/i.test(text) && /^(Execution|Build|Validation|❌)/.test(text)) phases[active].status = 'stopped';
    }
    const running = ticket && /^(executing|queued|stopping)$/.test(ticket.queueStatus || '');
    if (ticket && !running && phases[active].status === 'working') {
      phases[active].status = ticket.status === 'failed' ? 'error' : ticket.status === 'stopped' ? 'stopped' : 'unknown';
    }
    if (!buildStarted && (ticket?.githubCommitSha || ticket?.github_commit_sha || rows.some(r => /Retrying validation of saved commit|Validation passed.*saved commit/.test(String(r.message || '').replace(/\*\*/g, ''))))) phases[0].status = 'saved';
    return phases;
  }
  const histories = new Map();
  async function load(url, older = false) {
    const history = histories.get(url) || { rows: [], more: false };
    const cursor = older && history.rows[0]?.id;
    const response = await fetch(url + (cursor ? '?before=' + encodeURIComponent(cursor) : ''), { credentials: 'same-origin' });
    if (!response.ok) throw new Error('Could not load action history');
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Invalid action history');
    if (older || !histories.has(url)) history.more = rows.length === 500;
    const merged = new Map(history.rows.map(row => [row.id, row]));
    for (const row of rows) merged.set(row.id, row);
    history.rows = Array.from(merged.values()).sort((a,b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
    histories.set(url, history);
    return history.rows;
  }
  const choices = new Map();
  function render(area, rows, ticket, key, renderRow, historyUrl, refresh) {
    const phases = group(rows, ticket);
    area.dataset.phaseView = key;
    const history = histories.get(historyUrl);
    let selected = choices.has(key) ? choices.get(key) : (phases[1].rows.length ? 'validation' : 'build');
    const fragment = document.createDocumentFragment();
    const headers = document.createElement('div'); headers.className = 'phase-headers';
    const bodies = [];
    const buttons = [];
    function select(id) {
      selected = selected === id ? null : id;
      choices.set(key, selected);
      buttons.forEach((button, i) => button.setAttribute('aria-expanded', String(phases[i].id === selected)));
      bodies.forEach((body, i) => { body.hidden = phases[i].id !== selected; });
      area.scrollTop = 0;
    }
    let index = 0;
    for (const phase of phases) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'phase-header';
      button.setAttribute('aria-expanded', String(selected === phase.id));
      const body = document.createElement('div'); body.className = 'ticket-phase-body';
      body.id = 'phase-body-' + key.replace(/[^a-zA-Z0-9_-]/g, '-') + '-' + phase.id;
      button.setAttribute('aria-controls', body.id);
      const label = document.createElement('strong'); label.textContent = phase.label;
      const badge = document.createElement('span'); badge.className = 'phase-status phase-' + phase.status;
      badge.textContent = phase.status === 'saved' ? 'Saved code' : phase.status === 'unknown' ? 'Unknown' : phase.status[0].toUpperCase() + phase.status.slice(1);
      button.append(label, badge); button.onclick = () => select(phase.id);
      headers.append(button); buttons.push(button);
      for (const row of phase.rows) body.append(renderRow(row, index++));
      if (!phase.rows.length) {
        const empty = document.createElement('p'); empty.className = 'phase-empty';
        empty.textContent = phase.status === 'saved' ? 'This ticket already has saved code. This retry reused it.' : 'No logs available for this phase.';
        body.append(empty);
      }
      body.hidden = selected !== phase.id; bodies.push(body);
    }
    fragment.append(headers);
    if (history?.more) {
      const note = document.createElement('div'); note.className = 'phase-history-note'; note.setAttribute('role', 'status');
      note.textContent = history.error ? 'Older history could not load.' : 'Loading earlier history…';
      if (history.error) {
        const retry = document.createElement('button'); retry.textContent = 'Retry';
        retry.onclick = () => { history.error = false; render(area, rows, ticket, key, renderRow, historyUrl, refresh); }; note.append(retry);
      }
      fragment.append(note);
    }
    for (const body of bodies) fragment.append(body);
    area.replaceChildren(fragment);
    // Fetch each older page once, in the background. Viewing logs never runs the ticket.
    if (history?.more && !history.loading && !history.error && refresh) {
      history.loading = true;
      (async () => {
        try {
          while (history.more && area.isConnected && area.dataset.phaseView === key) {
            const first = history.rows[0]?.id;
            await load(historyUrl, true);
            if (history.more && history.rows[0]?.id === first) throw new Error('History cursor did not advance');
          }
        } catch (_) { history.error = true; }
        finally {
          history.loading = false;
          if (area.isConnected && area.dataset.phaseView === key) await refresh();
        }
      })();
    }
  }
  root.TicketActionPhases = { group, render, load };
})(typeof window === 'undefined' ? globalThis : window);
