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
    // Capture immediately, including a toggle whose event has not fired yet.
    for (const old of area.querySelectorAll('details[data-phase-key]')) choices.set(old.dataset.phaseKey, old.open);
    const fragment = document.createDocumentFragment();
    const history = histories.get(historyUrl);
    if (history?.more) {
      const older = document.createElement('button'); older.className = 'phase-older'; older.title = 'Show the next 500 older log entries. This does not rerun the ticket.'; older.textContent = 'Load older logs';
      older.onclick = async () => { older.disabled = true; older.textContent = 'Loading…'; try { await load(historyUrl, true); await refresh(); } catch (_) { older.disabled = false; older.textContent = 'Could not load — try again'; } };
      fragment.append(older);
    }
    let index = 0;
    for (const phase of phases) {
      const section = document.createElement('details');
      section.className = 'ticket-action-phase';
      const choiceKey = key + ':' + phase.id;
      section.dataset.phaseKey = choiceKey;
      section.open = choices.has(choiceKey) ? choices.get(choiceKey) : phase.status === 'working' || phase.status === 'error' || phase.id === 'validation' && phase.rows.length > 0;
      section.addEventListener('toggle', () => { if (section.isConnected) choices.set(choiceKey, section.open); });
      const summary = document.createElement('summary');
      const label = document.createElement('strong'); label.textContent = phase.label;
      const count = document.createElement('span'); count.className = 'phase-count'; count.textContent = phase.rows.length ? phase.rows.length + ' loaded entries' : 'Earlier logs not loaded';
      if (!phase.rows.length && phase.status === 'pending') count.textContent = 'Not started';
      const badge = document.createElement('span'); badge.className = 'phase-status phase-' + phase.status;
      badge.textContent = phase.status === 'saved' ? 'Saved code' : phase.status === 'unknown' ? 'Status unavailable' : phase.status[0].toUpperCase() + phase.status.slice(1);
      summary.append(label, count, badge); section.append(summary);
      const body = document.createElement('div'); body.className = 'ticket-phase-body';
      for (const row of phase.rows) body.append(renderRow(row, index++));
      if (!phase.rows.length) { const empty = document.createElement('p'); empty.className = 'phase-empty'; empty.textContent = phase.status === 'saved' ? 'This ticket already has saved code. This retry reused it. Load older logs to view the original build history.' : phase.status === 'skipped' ? 'Development was skipped for this validation retry; this is not the ticket’s complete build history.' : 'No actions loaded for this phase.'; body.append(empty); }
      section.append(body); fragment.append(section);
    }
    area.replaceChildren(fragment);
  }
  root.TicketActionPhases = { group, render, load };
})(typeof window === 'undefined' ? globalThis : window);
