document.addEventListener('DOMContentLoaded', function() {
  console.log('[Composio] Initializing integrations module');

  var overlay = document.getElementById('mcp-modal-overlay');
  var closeBtn = document.getElementById('mcp-modal-close');
  var mcpBtn = document.getElementById('mcp-servers-btn');
  var addForm = document.getElementById('composio-add-form');
  var badge = document.getElementById('mcp-count-badge');
  var listEl = document.getElementById('composio-toolkit-list');
  var settingsDropdown = document.getElementById('settings-dropdown');

  if (!mcpBtn) { console.error('[Composio] #mcp-servers-btn not found'); return; }
  if (!overlay) { console.error('[Composio] #mcp-modal-overlay not found'); return; }

  console.log('[Composio] Elements found, binding events');

  function openModal() {
    if (settingsDropdown) settingsDropdown.classList.remove('open');
    overlay.classList.add('open');
    loadToolkits();
  }

  function closeModal() {
    overlay.classList.remove('open');
  }

  mcpBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    e.preventDefault();
    console.log('[Composio] Integrations clicked');
    openModal();
  });

  closeBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeModal();
  });

  function loadToolkits() {
    fetch('/api/composio/toolkits', { credentials: 'include' })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        var toolkits = data.toolkits || [];
        renderToolkits(toolkits);
        updateBadge(toolkits);
      })
      .catch(function(err) {
        console.error('[Composio] Failed to load toolkits', err);
      });
  }

  function updateBadge(toolkits) {
    var enabledCount = toolkits.filter(function(t) { return t.enabled; }).length;
    if (enabledCount > 0) {
      badge.textContent = enabledCount;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }

  function escapeHtml(str) {
    var d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function renderToolkits(toolkits) {
    if (!toolkits.length) {
      listEl.innerHTML = '<div class="mcp-empty-state">No integrations connected yet. Add a toolkit below.</div>';
      return;
    }
    listEl.innerHTML = toolkits.map(function(t) {
      var toolsId = 'composio-tools-' + t.id;
      return '<div class="mcp-server-row" data-id="' + t.id + '">' +
        '<div class="mcp-server-info">' +
          '<span class="mcp-server-name">' + escapeHtml(t.toolkit) + '</span>' +
          '<span class="mcp-server-url" style="font-size:0.7rem;">Composio Toolkit</span>' +
        '</div>' +
        '<div class="mcp-server-actions">' +
          '<label class="mcp-toggle"><input type="checkbox"' + (t.enabled ? ' checked' : '') + ' onchange="window.__composioToggle(\'' + t.id + '\', this.checked)" /><span class="mcp-toggle-slider"></span></label>' +
          '<button type="button" class="mcp-test-btn" onclick="window.__composioPreview(\'' + t.id + '\', \'' + escapeHtml(t.toolkit) + '\')"><i class="fas fa-eye"></i></button>' +
          '<button type="button" class="mcp-delete-btn" onclick="window.__composioDelete(\'' + t.id + '\')"><i class="fas fa-trash"></i></button>' +
        '</div>' +
        '<div class="mcp-server-tools" id="' + toolsId + '"></div>' +
      '</div>';
    }).join('');
  }

  if (addForm) {
    addForm.addEventListener('submit', function(e) {
      e.preventDefault();
      var fd = new FormData(addForm);
      var toolkit = (fd.get('toolkit') || '').toString().trim().toUpperCase();
      if (!toolkit) return;

      fetch('/api/composio/toolkits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ toolkit: toolkit }),
      })
      .then(function() { addForm.reset(); loadToolkits(); })
      .catch(function(err) { console.error('[Composio] Failed to add toolkit', err); });
    });
  }

  window.__composioToggle = function(id, enabled) {
    fetch('/api/composio/toolkits/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ enabled: enabled }),
    })
    .then(function() { loadToolkits(); })
    .catch(function(err) { console.error('[Composio] Failed to toggle toolkit', err); });
  };

  window.__composioDelete = function(id) {
    if (!confirm('Remove this integration?')) return;
    fetch('/api/composio/toolkits/' + id, {
      method: 'DELETE',
      credentials: 'include',
    })
    .then(function() { loadToolkits(); })
    .catch(function(err) { console.error('[Composio] Failed to delete toolkit', err); });
  };

  window.__composioPreview = function(id, toolkit) {
    var toolsEl = document.getElementById('composio-tools-' + id);
    if (!toolsEl) return;
    toolsEl.textContent = 'Loading tools...';
    toolsEl.classList.remove('mcp-tools-error');
    fetch('/api/composio/tools/' + encodeURIComponent(toolkit), {
      credentials: 'include',
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (data.tools && data.tools.length) {
        toolsEl.textContent = 'Tools: ' + data.tools.slice(0, 10).join(', ') +
          (data.tools.length > 10 ? ' (+' + (data.tools.length - 10) + ' more)' : '');
      } else {
        toolsEl.textContent = 'No tools found — check toolkit name';
        toolsEl.classList.add('mcp-tools-error');
      }
    })
    .catch(function() {
      toolsEl.textContent = 'Failed to load tools';
      toolsEl.classList.add('mcp-tools-error');
    });
  };

  // Load badge count on page load
  loadToolkits();
});
