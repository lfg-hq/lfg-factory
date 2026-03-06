/**
 * Sharing modal — create and copy share links for files and tickets.
 *
 * Usage:
 *   openShareModal(resourceType, resourceId, projectId)
 *   - resourceType: "file" | "ticket"
 *   - resourceId: UUID of the file or ticket
 *   - projectId: public projectId
 */

(function () {
  "use strict";

  // Inject modal HTML on first use
  var modalInjected = false;

  function ensureModal() {
    if (modalInjected) return;
    modalInjected = true;

    var div = document.createElement("div");
    div.innerHTML =
      '<div id="shareModal" class="modal-overlay" style="display:none;position:fixed;inset:0;z-index:1000;background:rgba(0,0,0,0.7);align-items:center;justify-content:center;">' +
        '<div style="background:var(--card-bg);border:1px solid var(--border-color);border-radius:var(--radius-lg);width:100%;max-width:440px;position:relative;">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;padding:1.25rem 1.5rem;border-bottom:1px solid var(--border-color);">' +
            '<h3 style="margin:0;font-size:1.1rem;font-weight:600;color:var(--text-color);"><i class="fas fa-share-nodes"></i> Share</h3>' +
            '<button type="button" onclick="closeShareModal()" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;font-size:1.1rem;padding:0.25rem;"><i class="fas fa-times"></i></button>' +
          '</div>' +
          '<div style="padding:1.5rem;">' +
            '<div id="shareModalBody">' +
              '<p style="font-size:0.875rem;color:var(--text-secondary);margin:0 0 1rem;">Create a public link anyone can view without signing in.</p>' +
              '<button id="shareCreateBtn" class="btn btn-primary" style="width:100%;" onclick="createShareLink()"><i class="fas fa-link"></i> Create Share Link</button>' +
            '</div>' +
            '<div id="shareModalResult" style="display:none;">' +
              '<p style="font-size:0.875rem;color:var(--text-secondary);margin:0 0 0.75rem;">Anyone with this link can view:</p>' +
              '<div style="display:flex;gap:0.5rem;">' +
                '<input type="text" id="shareLinkUrl" readonly class="input" style="flex:1;font-size:0.8125rem;" />' +
                '<button class="btn btn-primary" onclick="copyShareLink()" id="shareCopyBtn"><i class="fas fa-copy"></i> Copy</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(div.firstChild);

    // Close on overlay click
    document.getElementById("shareModal").addEventListener("click", function (e) {
      if (e.target === this) closeShareModal();
    });
  }

  var currentResourceType = "";
  var currentResourceId = "";
  var currentProjectId = "";

  window.openShareModal = function (resourceType, resourceId, projectId) {
    ensureModal();
    currentResourceType = resourceType;
    currentResourceId = resourceId;
    currentProjectId = projectId;

    document.getElementById("shareModalBody").style.display = "block";
    document.getElementById("shareModalResult").style.display = "none";
    document.getElementById("shareModal").style.display = "flex";
  };

  window.closeShareModal = function () {
    document.getElementById("shareModal").style.display = "none";
  };

  window.createShareLink = function () {
    var btn = document.getElementById("shareCreateBtn");
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Creating...';

    fetch("/api/projects/" + currentProjectId + "/share-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceType: currentResourceType,
        resourceId: currentResourceId,
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.url) {
          var fullUrl = window.location.origin + data.url;
          document.getElementById("shareLinkUrl").value = fullUrl;
          document.getElementById("shareModalBody").style.display = "none";
          document.getElementById("shareModalResult").style.display = "block";
        } else {
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-link"></i> Create Share Link';
          alert(data.error || "Failed to create link");
        }
      })
      .catch(function () {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-link"></i> Create Share Link';
      });
  };

  window.copyShareLink = function () {
    var input = document.getElementById("shareLinkUrl");
    navigator.clipboard.writeText(input.value).then(function () {
      var btn = document.getElementById("shareCopyBtn");
      btn.innerHTML = '<i class="fas fa-check"></i> Copied!';
      setTimeout(function () {
        btn.innerHTML = '<i class="fas fa-copy"></i> Copy';
      }, 2000);
    });
  };
})();
