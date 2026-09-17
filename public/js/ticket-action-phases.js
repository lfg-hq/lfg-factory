/* Shared by the ticket drawer and the chat ticket panel. No log content is discarded. */
(function (root) {
  function group(rows, ticket) {
    const phases = [{ id: 'build', label: 'Build', status: 'pending', rows: [] }, { id: 'validation', label: 'Validation', status: 'pending', rows: [] }];
    let active = 0;
    for (const row of rows) {
      const text = String(row.message || '').replace(/\*\*/g, '').trim();
      const retry = /^Retrying validation of saved commit/i.test(text);
      const validation = retry || /^(Running the saved ticket:|Repairing runtime checks:|Checking:|Preparing validation:|Now verifying this commit|Fresh \/ candidate:|Runtime checks passed|✅\s*Validation passed)/i.test(text);
      const build = /^(Starting Pi build|Isolated build:|Starting (?:ticket )?build|Building ticket)/i.test(text);
      if (build) { active = 0; phases[0].status = 'working'; phases[1].status = 'pending'; }
      if (validation) {
        active = 1;
        if (phases[0].status === 'working') phases[0].status = 'done';
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
    return phases;
  }
  const choices = new Map();
  function render(area, rows, ticket, key, renderRow) {
    const phases = group(rows, ticket);
    // Capture immediately, including a toggle whose event has not fired yet.
    for (const old of area.querySelectorAll('details[data-phase-key]')) choices.set(old.dataset.phaseKey, old.open);
    const fragment = document.createDocumentFragment();
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
      const count = document.createElement('span'); count.className = 'phase-count'; count.textContent = phase.rows.length + ' actions';
      const badge = document.createElement('span'); badge.className = 'phase-status phase-' + phase.status;
      badge.textContent = phase.status === 'unknown' ? 'Status unavailable' : phase.status[0].toUpperCase() + phase.status.slice(1);
      summary.append(label, count, badge); section.append(summary);
      const body = document.createElement('div'); body.className = 'ticket-phase-body';
      for (const row of phase.rows) body.append(renderRow(row, index++));
      if (!phase.rows.length) { const empty = document.createElement('p'); empty.className = 'phase-empty'; empty.textContent = phase.status === 'skipped' ? 'Development was skipped for this validation retry.' : 'No actions yet.'; body.append(empty); }
      section.append(body); fragment.append(section);
    }
    area.replaceChildren(fragment);
  }
  root.TicketActionPhases = { group, render };
})(typeof window === 'undefined' ? globalThis : window);
