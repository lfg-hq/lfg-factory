document.addEventListener('DOMContentLoaded', function() {
  console.log('[MCP] Initializing integrations module');

  var overlay = document.getElementById('mcp-modal-overlay');
  var closeBtn = document.getElementById('mcp-modal-close');
  var mcpBtn = document.getElementById('mcp-servers-btn');
  var addForm = document.getElementById('mcp-add-form');
  var badge = document.getElementById('mcp-count-badge');
  var listEl = document.getElementById('mcp-server-list');
  var settingsDropdown = document.getElementById('settings-dropdown');

  if (!mcpBtn) { console.error('[MCP] #mcp-servers-btn not found'); return; }
  if (!overlay) { console.error('[MCP] #mcp-modal-overlay not found'); return; }

  console.log('[MCP] Elements found, binding events');

  function openModal() {
    if (settingsDropdown) settingsDropdown.classList.remove('open');
    overlay.classList.add('open');
    loadMcpServers();
  }

  function closeModal() {
    overlay.classList.remove('open');
  }

  mcpBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    e.preventDefault();
    console.log('[MCP] Integrations clicked');
    openModal();
  });

  closeBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeModal();
  });

  function loadMcpServers() {
    fetch('/api/mcp/servers', { credentials: 'include' })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        var servers = data.servers || [];
        renderServers(servers);
        updateBadge(servers);
      })
      .catch(function(err) {
        console.error('[MCP] Failed to load servers', err);
      });
  }

  function updateBadge(servers) {
    var enabledCount = servers.filter(function(s) { return s.enabled; }).length;
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

  function renderServers(servers) {
    if (!servers.length) {
      listEl.innerHTML = '<div class="mcp-empty-state">No integrations configured yet.</div>';
      return;
    }
    listEl.innerHTML = servers.map(function(s) {
      var toolsId = 'mcp-tools-' + s.id;
      return '<div class="mcp-server-row" data-id="' + s.id + '">' +
        '<div class="mcp-server-info">' +
          '<span class="mcp-server-name">' + escapeHtml(s.name) + '</span>' +
          '<span class="mcp-server-url">' + escapeHtml(s.url) + '</span>' +
        '</div>' +
        '<div class="mcp-server-actions">' +
          '<label class="mcp-toggle"><input type="checkbox"' + (s.enabled ? ' checked' : '') + ' onchange="window.__mcpToggle(\'' + s.id + '\', this.checked)" /><span class="mcp-toggle-slider"></span></label>' +
          '<button type="button" class="mcp-test-btn" onclick="window.__mcpTest(\'' + s.id + '\')"><i class="fas fa-vial"></i></button>' +
          '<button type="button" class="mcp-delete-btn" onclick="window.__mcpDelete(\'' + s.id + '\')"><i class="fas fa-trash"></i></button>' +
        '</div>' +
        '<div class="mcp-server-tools" id="' + toolsId + '"></div>' +
      '</div>';
    }).join('');
  }

  if (addForm) {
    addForm.addEventListener('submit', function(e) {
      e.preventDefault();
      var fd = new FormData(addForm);
      var body = {
        name: fd.get('name'),
        transportType: fd.get('transportType'),
        url: fd.get('url'),
      };
      var hdrs = fd.get('headers');
      if (hdrs) body.headers = hdrs;

      fetch('/api/mcp/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      })
      .then(function() { addForm.reset(); loadMcpServers(); })
      .catch(function(err) { console.error('[MCP] Failed to add server', err); });
    });
  }

  window.__mcpToggle = function(id, enabled) {
    fetch('/api/mcp/servers/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ enabled: enabled }),
    })
    .then(function() { loadMcpServers(); })
    .catch(function(err) { console.error('[MCP] Failed to toggle server', err); });
  };

  window.__mcpDelete = function(id) {
    if (!confirm('Remove this integration?')) return;
    fetch('/api/mcp/servers/' + id, {
      method: 'DELETE',
      credentials: 'include',
    })
    .then(function() { loadMcpServers(); })
    .catch(function(err) { console.error('[MCP] Failed to delete server', err); });
  };

  window.__mcpTest = function(id) {
    var toolsEl = document.getElementById('mcp-tools-' + id);
    if (!toolsEl) return;
    toolsEl.textContent = 'Testing...';
    toolsEl.classList.remove('mcp-tools-error');
    fetch('/api/mcp/servers/' + id + '/test', {
      method: 'POST',
      credentials: 'include',
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (data.success && data.tools && data.tools.length) {
        toolsEl.textContent = 'Tools: ' + data.tools.map(function(t) { return t.name; }).join(', ');
      } else if (data.error) {
        toolsEl.textContent = 'Error: ' + data.error;
        toolsEl.classList.add('mcp-tools-error');
      } else {
        toolsEl.textContent = 'Connected — no tools found';
      }
    })
    .catch(function() {
      toolsEl.textContent = 'Connection failed';
      toolsEl.classList.add('mcp-tools-error');
    });
  };

  // Load badge count on page load
  loadMcpServers();
});
