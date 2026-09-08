(() => {
  const root = document.querySelector('.team-settings');
  if (!root) return;
  const toast = root.querySelector('.tm-toast');
  let timer;
  const notify = (message, error = false) => {
    clearTimeout(timer);
    toast.textContent = message;
    toast.dataset.error = String(error);
    toast.hidden = false;
    timer = setTimeout(() => { toast.hidden = true; }, 4500);
  };
  const invite = document.getElementById('tm-invite-toggle');
  invite?.addEventListener('click', () => {
    const panel = document.getElementById('tm-invite-panel');
    panel.hidden = !panel.hidden;
    invite.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) document.getElementById('tm-email').focus();
  });
  root.querySelectorAll('[data-copy-invite]').forEach(button => {
    button.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(button.dataset.copyInvite); notify('Invitation link copied'); }
      catch { notify('Could not copy the link. Check clipboard permissions.', true); }
    });
  });
  root.querySelectorAll('[data-team-form]').forEach(form => {
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const data = new FormData(form);
      if (event.submitter?.name) data.set(event.submitter.name, event.submitter.value);
      const controls = [...form.querySelectorAll('button, input, select')];
      const disabled = controls.map(el => el.disabled);
      controls.forEach(el => { el.disabled = true; });
      try {
        const response = await fetch(form.action, { method: 'POST', body: new URLSearchParams(data) });
        if (!response.ok) throw new Error((await response.text()).replace(/<[^>]*>/g, '').slice(0, 200) || 'Could not save changes');
        if (new URL(response.url).pathname.startsWith('/auth/')) { location.assign(response.url); return; }
        if (form.dataset.teamForm === 'policy' || (form.dataset.teamForm === 'member' && data.get('action') === 'update')) {
          notify(form.dataset.teamForm === 'policy' ? 'Workspace settings saved' : 'Member role updated');
        } else {
          sessionStorage.setItem('team-settings-notice', form.dataset.teamForm === 'invite' ? 'Invitation created. Copy the link below to share it.' : 'Team updated');
          location.reload();
        }
      } catch (error) { notify(error.message || 'Could not save changes', true); }
      finally { controls.forEach((el, i) => { el.disabled = disabled[i]; }); }
    });
  });
  const message = sessionStorage.getItem('team-settings-notice');
  if (message) { sessionStorage.removeItem('team-settings-notice'); notify(message); }
})();
