(() => {
  const fields = {validationEnabled: document.getElementById('cfg-validation-enabled'), featureTestingEnabled: document.getElementById('cfg-feature-testing-enabled')};
  const status = document.getElementById('cfg-build-stages-status');
  if (!status) return;
  const project = location.pathname.split('/projects/')[1]?.split('/')[0];
  const url = '/api/projects/' + encodeURIComponent(project) + '/preview/build-settings';
  fetch(url).then(r => { if (!r.ok) throw Error('Could not load build checks'); return r.json(); }).then(data => {
    for (const [field,input] of Object.entries(fields)) {
      input.checked = data[field] !== false;
      input.disabled = !data.canChangeBuildStages;
      input.addEventListener('change', async () => {
        const value = input.checked; input.disabled = true;
        try {
          const response = await fetch(url, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({[field]:value})});
          if (!response.ok) throw Error('Could not save build checks');
          status.textContent = 'Saved. Applies to the next check run. Reload open tickets to update their tabs.';
        } catch(error) { input.checked = !value; status.textContent = error.message; }
        finally { input.disabled = !data.canChangeBuildStages; }
      });
    }
    status.textContent = data.canChangeBuildStages ? 'Both checks are enabled by default.' : 'Only the project owner can change these settings.';
  }).catch(error => { status.textContent = error.message; });
})();
