(() => {
  const input = document.getElementById('cfg-epic-builds');
  if (!input) return;
  const message = document.getElementById('cfg-epic-builds-status');
  const project = location.pathname.split('/projects/')[1]?.split('/')[0];
  const url = '/api/projects/' + encodeURIComponent(project) + '/preview/build-settings';
  fetch(url).then(r => { if (!r.ok) throw Error('Could not load setting'); return r.json(); }).then(data => {
    input.checked = !!data.epicBuildsEnabled;
    input.disabled = !data.canChangeEpicBuilds;
    message.textContent = data.canChangeEpicBuilds ? 'Off by default. Changes apply to new chat requests; reload open chats to update their panels.' : 'Only the project owner can change this setting.';
  }).catch(e => message.textContent = e.message);
  input.addEventListener('change', async () => {
    const enabled = input.checked; input.disabled = true;
    try {
      const r = await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({epicBuildsEnabled:enabled})});
      if (!r.ok) throw Error('Could not save setting');
      message.textContent = 'Saved. Reload open chats to use the ' + (enabled ? 'epic' : 'ticket') + ' workflow.';
    } catch(e) { input.checked = !enabled; message.textContent = e.message; }
    finally { input.disabled = false; }
  });
})();
