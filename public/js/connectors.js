document.addEventListener('DOMContentLoaded', function () {
  var overlay = document.getElementById('connectors-overlay');
  var detailOverlay = document.getElementById('connector-detail-overlay');
  var connectorsBtn = document.getElementById('connectors-btn');
  var closeBtn = document.getElementById('connectors-close');
  var detailCloseBtn = document.getElementById('connector-detail-close');
  var searchInput = document.getElementById('connectors-search');
  var grid = document.getElementById('connectors-grid');
  var badge = document.getElementById('connector-badge');
  var loadMoreWrap = document.getElementById('connectors-load-more');

  if (!connectorsBtn || !overlay) return;

  var currentFilter = 'all';
  var currentCursor = null;
  var searchTimeout = null;

  function open() {
    overlay.classList.add('open');
    loadConnectors();
  }
  function close() { overlay.classList.remove('open'); }

  // Public entrypoint: open the modal pre-filtered to a specific toolkit slug.
  // Used by agents.js when the agent's requestConnectorAuth tool fires —
  // surfaces the right service to connect without the user having to search.
  window.openConnectorsModal = function (prefilterSlug) {
    if (prefilterSlug) {
      currentFilter = 'all';
      document.querySelectorAll('.connectors-tab').forEach(function (t) {
        t.classList.toggle('active', t.dataset.filter === 'all');
      });
      currentCursor = null;
      searchInput.value = prefilterSlug;
    }
    open();
  };
  function openDetail(item) {
    document.getElementById('connector-detail-logo').src = item.logo || '';
    document.getElementById('connector-detail-name').textContent = item.name;
    document.getElementById('connector-detail-desc').textContent = item.description || '';
    var btn = document.getElementById('connector-detail-action');
    if (item.isConnected) {
      btn.textContent = 'Disconnect';
      btn.className = 'connector-detail-action-btn disconnect';
      btn.onclick = function () { doDisconnect(item.slug); };
    } else {
      btn.textContent = 'Add connector';
      btn.className = 'connector-detail-action-btn';
      btn.onclick = function () { doConnect(item.slug); };
    }
    detailOverlay.classList.add('open');
  }
  function closeDetail() { detailOverlay.classList.remove('open'); }

  connectorsBtn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); open(); });
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
  detailCloseBtn.addEventListener('click', closeDetail);
  detailOverlay.addEventListener('click', function (e) { if (e.target === detailOverlay) closeDetail(); });

  // Tabs
  document.querySelectorAll('.connectors-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.connectors-tab').forEach(function (t) { t.classList.remove('active'); });
      tab.classList.add('active');
      currentFilter = tab.dataset.filter;
      currentCursor = null;
      loadConnectors();
    });
  });

  // Search
  searchInput.addEventListener('input', function () {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(function () {
      currentCursor = null;
      loadConnectors();
    }, 300);
  });

  function loadConnectors(append) {
    if (!append) {
      grid.innerHTML = '<div class="connectors-loading">Loading connectors...</div>';
    }
    var params = new URLSearchParams({ filter: currentFilter, limit: '50' });
    var q = searchInput.value.trim();
    if (q) params.set('search', q);
    if (currentCursor && append) params.set('cursor', currentCursor);

    fetch('/api/composio/connectors?' + params.toString(), { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.configured) {
          grid.innerHTML = '<div class="connectors-empty">Connectors are not configured yet.</div>';
          return;
        }
        var items = data.items || [];
        if (!append) grid.innerHTML = '';
        if (!items.length && !append) {
          grid.innerHTML = '<div class="connectors-empty">No connectors found.</div>';
        }
        items.forEach(function (item) { grid.appendChild(createCard(item)); });
        currentCursor = data.nextCursor;
        loadMoreWrap.style.display = data.nextCursor ? 'block' : 'none';
        updateBadge();
      })
      .catch(function () {
        if (!append) grid.innerHTML = '<div class="connectors-empty">Failed to load connectors.</div>';
      });
  }

  if (loadMoreWrap) {
    loadMoreWrap.querySelector('.connectors-load-more-btn').addEventListener('click', function () {
      loadConnectors(true);
    });
  }

  function createCard(item) {
    var card = document.createElement('div');
    card.className = 'connector-card' + (item.isConnected ? ' connected' : '');
    card.innerHTML =
      '<img class="connector-logo" src="' + esc(item.logo) + '" alt="" onerror="this.style.display=\'none\'" />' +
      '<div class="connector-info">' +
        '<div class="connector-name">' + esc(item.name) +
          (item.isConnected ? ' <span class="connector-connected-dot"></span>' : '') +
        '</div>' +
        '<div class="connector-desc">' + esc(item.description || '').slice(0, 80) + (item.description && item.description.length > 80 ? '...' : '') + '</div>' +
      '</div>';
    card.addEventListener('click', function () { openDetail(item); });
    return card;
  }

  function doConnect(toolkit) {
    var btn = document.getElementById('connector-detail-action');
    btn.textContent = 'Connecting...';
    btn.disabled = true;
    fetch('/api/composio/connectors/' + encodeURIComponent(toolkit) + '/connect', {
      method: 'POST',
      credentials: 'include',
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.redirectUrl) {
          window.location.href = data.redirectUrl;
        } else if (data.connected) {
          closeDetail();
          loadConnectors();
        } else if (data.error) {
          btn.textContent = 'Error: ' + data.error;
          btn.disabled = false;
        }
      })
      .catch(function () { btn.textContent = 'Failed'; btn.disabled = false; });
  }

  function doDisconnect(toolkit) {
    var btn = document.getElementById('connector-detail-action');
    btn.textContent = 'Disconnecting...';
    btn.disabled = true;
    fetch('/api/composio/connectors/' + encodeURIComponent(toolkit) + '/disconnect', {
      method: 'POST',
      credentials: 'include',
    })
      .then(function () { closeDetail(); loadConnectors(); })
      .catch(function () { btn.textContent = 'Failed'; btn.disabled = false; });
  }

  function updateBadge() {
    var connected = grid.querySelectorAll('.connector-card.connected').length;
    // Also fetch from API for accuracy
    fetch('/api/composio/toolkits', { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var count = (data.toolkits || []).filter(function (t) { return t.enabled; }).length;
        if (count > 0) { badge.textContent = count; badge.style.display = 'flex'; }
        else { badge.style.display = 'none'; }
      }).catch(function () {});
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  // Update badge on load
  updateBadge();
});
