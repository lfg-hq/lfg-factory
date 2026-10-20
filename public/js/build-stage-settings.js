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
  }).catch(error => { status.textContent = error.message; });
})();
