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
    // Where builds and previews run (sandbox / each person's computer / their own setting).
    const runOn = document.getElementById('cfg-run-on');
    const runOnStatus = document.getElementById('cfg-run-on-status');
    if (runOn && runOnStatus) {
      const describe = v => v === 'cloud' ? 'Builds and previews run in an LFG sandbox.'
        : v === 'computer' ? 'Builds and previews run on the computer of whoever starts them, through LFG Desktop. Without it they fall back to a sandbox.'
        : 'Each person\u2019s "Use my computer for AI" setting decides.';
      let saved = data.runOn || '';
      runOn.value = saved;
      runOn.disabled = !data.canChangeBuildStages;
      runOnStatus.textContent = describe(saved) + (data.canChangeBuildStages ? '' : ' Only the project owner can change this.');
      runOn.addEventListener('change', async () => {
        const value = runOn.value; runOn.disabled = true;
        try {
          const response = await fetch(url, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runOn:value})});
          if (!response.ok) throw Error((await response.json().catch(() => ({}))).error || 'Could not save');
          saved = value; runOnStatus.textContent = 'Saved. ' + describe(value);
        } catch (error) { runOn.value = saved; runOnStatus.textContent = error.message; }
        finally { runOn.disabled = false; }
      });
    }
  }).catch(error => { status.textContent = error.message; });
})();
