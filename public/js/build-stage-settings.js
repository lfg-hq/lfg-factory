(() => {
  // One "Checks" stage: app startup plus the browser walkthrough, saved as both flags.
  const input = document.getElementById('cfg-checks-enabled');
  const status = document.getElementById('cfg-build-stages-status');
  if (!input || !status) return;
  const project = location.pathname.split('/projects/')[1]?.split('/')[0];
  const url = '/api/projects/' + encodeURIComponent(project) + '/preview/build-settings';
  fetch(url).then(r => { if (!r.ok) throw Error('Could not load build checks'); return r.json(); }).then(data => {
    input.checked = data.validationEnabled !== false || data.featureTestingEnabled !== false;
    input.disabled = !data.canChangeBuildStages;
    input.addEventListener('change', async () => {
      const value = input.checked; input.disabled = true;
      try {
        const response = await fetch(url, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({validationEnabled:value,featureTestingEnabled:value})});
        if (!response.ok) throw Error('Could not save build checks');
        status.textContent = value ? 'Saved. Checks run after the next build.' : 'Saved. Builds are committed without checks.';
      } catch(error) { input.checked = !value; status.textContent = error.message; }
      finally { input.disabled = !data.canChangeBuildStages; }
    });
    status.textContent = data.canChangeBuildStages ? 'Off by default for new projects.' : 'Only the project owner can change this setting.';
    // Where builds and previews run, each on its own: a sandbox, each person's computer, or their own setting.
    const runOnStatus = document.getElementById('cfg-run-on-status');
    const where = v => v === 'cloud' ? 'in an LFG sandbox' : v === 'computer' ? 'on the computer of whoever starts them (LFG Desktop; a sandbox without it)' : 'where each person\u2019s "Use my computer for AI" setting says';
    const describe = () => 'Builds run ' + where(document.getElementById('cfg-run-on').value) + '. Previews run ' + where(document.getElementById('cfg-preview-on').value) + '.';
    const selects = ['cfg-run-on', 'cfg-preview-on'].map(id => document.getElementById(id)).filter(Boolean);
    if (selects.length === 2 && runOnStatus) {
      for (const select of selects) {
        const field = select.dataset.field;
        let saved = data[field] || '';
        select.value = saved;
        select.disabled = !data.canChangeBuildStages;
        select.addEventListener('change', async () => {
          const value = select.value; select.disabled = true;
          try {
            const response = await fetch(url, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({[field]:value})});
            if (!response.ok) throw Error((await response.json().catch(() => ({}))).error || 'Could not save');
            saved = value; runOnStatus.textContent = 'Saved. ' + describe();
          } catch (error) { select.value = saved; runOnStatus.textContent = error.message; }
          finally { select.disabled = false; }
        });
      }
      runOnStatus.textContent = describe() + (data.canChangeBuildStages ? '' : ' Only the project owner can change this.');
    }
  }).catch(error => { status.textContent = error.message; });
})();
