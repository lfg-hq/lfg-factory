/**
 * Instant Mode — chat + live preview
 * Reuses the same message UI patterns as the main chat (chat.js).
 */
document.addEventListener('DOMContentLoaded', () => {
    const config = window.INSTANT_CONFIG || {};
    const projectId = config.projectId;
    const projectDbId = config.projectDbId;
    const standaloneMode = config.standaloneMode || false;

    const messageContainer = document.getElementById('message-container');
    const chatMessages = document.getElementById('chat-messages');
    const chatForm = document.getElementById('chat-form');
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');
    const previewIframe = document.getElementById('preview-iframe');
    const previewPlaceholder = document.getElementById('preview-placeholder');
    const previewBuilding = document.getElementById('preview-building');
    const buildingMessage = document.getElementById('building-message');
    const previewUrlBar = document.getElementById('preview-url-bar');
    const previewUrlText = document.getElementById('preview-url-text');
    const previewOpenBtn = document.getElementById('preview-open-btn');
    const previewRefreshBtn = document.getElementById('preview-refresh-btn');
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');

    let socket = null;
    let conversationId = config.conversationId;
    let isStreaming = false;
    let currentAssistantEl = null;
    let currentRawContent = '';
    let historyLoaded = false;

    // Agent-busy state drives the send↔stop button. `streamBusy` spans a whole
    // turn (send → is_final), independent of intermediate finishStreaming() calls
    // that just close text bubbles. `buildBusy` spans an app build.
    let streamBusy = false;
    let buildBusy = false;
    function updateSendBtn() {
        const busy = streamBusy || buildBusy;
        sendBtn.classList.toggle('busy', busy);
        sendBtn.disabled = false; // stay clickable so the user can stop
        sendBtn.title = busy ? 'Stop' : 'Send';
        const icon = sendBtn.querySelector('i');
        if (icon) icon.className = busy ? 'fas fa-stop' : 'fas fa-paper-plane';
    }
    function stopGeneration() {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'stop_generation' }));
        }
    }

    // ---- WebSocket ----

    function connectWebSocket() {
        if (socket && socket.readyState === WebSocket.OPEN) return;

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsPath = (window.__WS_PATH__ || '/ws/chat').replace(/\/+$/, '');
        let wsUrl = `${protocol}//${window.location.host}${wsPath}/`;
        const params = [];
        if (conversationId) params.push(`conversation_id=${conversationId}`);
        if (projectId) params.push(`project_id=${projectId}`);
        if (params.length) wsUrl += '?' + params.join('&');

        socket = new WebSocket(wsUrl);

        socket.onopen = () => {
            console.log('[Instant] WS connected');
        };

        socket.onmessage = (e) => {
            const data = JSON.parse(e.data);
            handleMessage(data);
        };

        socket.onclose = () => {
            console.log('[Instant] WS closed, reconnecting in 3s...');
            // Don't leave the button stuck as "Stop" if the connection drops mid-turn.
            streamBusy = false;
            buildBusy = false;
            updateSendBtn();
            setTimeout(connectWebSocket, 3000);
        };

        socket.onerror = (err) => {
            console.error('[Instant] WS error', err);
        };
    }

    function handleMessage(data) {
        const type = data.type;

        if (type === 'heartbeat') return;

        // Chat history load
        if (type === 'chat_history') {
            if (historyLoaded) return; // Don't re-render on WS reconnect
            historyLoaded = true;
            console.log('[Instant] WS chat_history received,', (data.messages || []).length, 'messages');

            const result = renderHistoryMessages(data.messages);
            // Load preview URL — prefer history, fallback to config
            const resolvedUrl = result.previewUrl || config.previewUrl;
            if (resolvedUrl) {
                loadPreview(resolvedUrl);
                setStatus('running', (result.appName || 'App') + ' is live');
            }
            scrollToBottom();
            maybeRenderPersistedQa();
            return;
        }

        // AI streaming chunk
        if (type === 'ai_chunk') {
            // Notification handling
            if (data.is_notification) {
                handleNotification(data);
                return;
            }

            // Final signal — the agent's turn is over
            if (data.is_final) {
                if (data.conversation_id && !conversationId) {
                    conversationId = data.conversation_id;
                }
                streamBusy = false;
                finishStreaming();
                return;
            }

            // Text chunk
            if (data.chunk) {
                if (!isStreaming) startStreaming();
                appendChunk(data.chunk);
            }
            return;
        }
    }

    function handleNotification(data) {
        const ntype = data.notification_type;

        // Ignore notifications from other conversations (e.g. another app tab)
        if (data.conversation_id && conversationId && data.conversation_id !== conversationId) {
            return;
        }

        if (ntype === 'instant_app_building' || ntype === 'instant_app_status') {
            const status = data.instant_app_status || 'building';
            const message = data.message || 'Building...';

            // Capture app_id from notification if we don't have it yet
            if (data.instant_app_id && !config.currentAppId) {
                config.currentAppId = data.instant_app_id;
                // Update browser URL so refresh loads this app
                const appUrl = (standaloneMode || !projectId)
                    ? `/instant/app/${data.instant_app_id}`
                    : `/instant/project/${projectId}/app/${data.instant_app_id}`;
                history.replaceState(null, '', appUrl);
                showActionsIfReady();

                // Update header to show app name + status
                const appName = data.app_name || data.instant_app_name || 'Building...';
                const headerLeft = document.querySelector('.instant-chat-header-left');
                if (headerLeft) {
                    headerLeft.innerHTML = `<span class="instant-app-name" title="${appName}">${appName}</span>`
                        + `<span class="instant-app-status-badge building">building</span>`;
                }

                // Add to sidebar app list if it exists
                const sidebarList = document.getElementById('sidebar-app-list');
                if (sidebarList) {
                    const emptyLabel = sidebarList.querySelector('.sidebar-section-label + .sidebar-app-item') ? null : sidebarList;
                    const item = document.createElement('a');
                    item.href = appUrl;
                    item.className = 'sidebar-app-item active';
                    item.title = appName;
                    item.innerHTML = `<span class="sidebar-app-name">${appName}</span>`
                        + `<span class="sidebar-app-status building">building</span>`;
                    sidebarList.appendChild(item);
                } else {
                    // Create sidebar app list section if none exists
                    const sidebarTop = document.querySelector('.sidebar-top-content');
                    if (sidebarTop) {
                        const listDiv = document.createElement('div');
                        listDiv.className = 'sidebar-app-list';
                        listDiv.id = 'sidebar-app-list';
                        listDiv.innerHTML = `<div class="sidebar-section-label">Your Apps</div>`
                            + `<a href="${appUrl}" class="sidebar-app-item active" title="${appName}">`
                            + `<span class="sidebar-app-name">${appName}</span>`
                            + `<span class="sidebar-app-status building">building</span></a>`;
                        sidebarTop.appendChild(listDiv);
                    }
                }

                // Update switcher dropdown — add the new app
                const switcherMenu = document.getElementById('app-switcher-menu');
                if (switcherMenu) {
                    const emptyMsg = switcherMenu.querySelector('.instant-switcher-empty');
                    if (emptyMsg) emptyMsg.remove();
                    // Deactivate "New App" link
                    const newAppItem = switcherMenu.querySelector('.instant-switcher-item.active');
                    if (newAppItem) newAppItem.classList.remove('active');
                    const link = document.createElement('a');
                    link.href = appUrl;
                    link.className = 'instant-switcher-item active';
                    link.innerHTML = `<span class="switcher-item-name">${appName}</span>`
                        + `<span class="switcher-item-status building">building</span>`;
                    switcherMenu.appendChild(link);
                }
            }

            if (status === 'error') {
                setPreviewState('building', message);
                setStatus('error', 'Error');
                if (buildingMessage) buildingMessage.style.color = 'var(--danger, #e74c3c)';
                showActionsIfReady();
                buildBusy = false;
                updateSendBtn();
            } else {
                if (buildingMessage) buildingMessage.style.color = '';
                setPreviewState('building', message);
                setStatus(status, 'Building');
                buildBusy = status !== 'running';
                updateSendBtn();
            }
            appendBuildNotice(message, status, data.error_type);
        }

        if (ntype === 'env_var_request') {
            const envData = data.data || {};
            appendEnvVarRequest(envData.key, envData.description, envData.required !== false, envData.app_id);
            // Also add to the Env tab as a placeholder so the key is visible there
            if (envData.key) {
                const existing = document.querySelector(`.env-row .env-key-input[value="${CSS.escape(envData.key)}"]`);
                if (!existing) addEnvRow(envData.key, '', true);
            }
            return;
        }

        if (ntype === 'web_search' || ntype === 'google_search') {
            appendSearchNotice();
            return;
        }

        if (ntype === 'instant_app_test') {
            handleQaNotification(data);
            return;
        }

        if (ntype === 'plan_proposal' || ntype === 'design_proposal') {
            const proposal = data.data || data;
            // Adopt the draft app's URL so a refresh reloads the conversation (and
            // re-renders this proposal from history). Without this, the proposal is
            // created on the bare /instant page and vanishes on reload.
            const proposalAppId = proposal.app_id || data.instant_app_id;
            if (proposalAppId && !config.currentAppId) {
                config.currentAppId = proposalAppId;
                const appUrl = (standaloneMode || !projectId)
                    ? `/instant/app/${proposalAppId}`
                    : `/instant/project/${projectId}/app/${proposalAppId}`;
                history.replaceState(null, '', appUrl);
                showActionsIfReady();
            }
            if (ntype === 'plan_proposal') renderPlanProposal(proposal);
            else renderDesignProposal(proposal);
            return;
        }

        if (ntype === 'ask_user') {
            console.log('ask_user raw payload:', JSON.stringify(data).slice(0, 800));

            // Normalize: support both questions[] array and legacy single-question format
            var sections;
            if (data.questions && Array.isArray(data.questions) && data.questions.length > 0) {
                sections = data.questions;
            } else if (data.questions && !Array.isArray(data.questions)) {
                sections = [data.questions];
            } else if (data.suggestions && Array.isArray(data.suggestions) && data.suggestions.length > 0) {
                sections = [{ question: data.question || 'Choose an option', suggestions: data.suggestions, context: data.context || '' }];
            } else {
                console.warn('ask_user notification has no questions/suggestions, skipping');
                return;
            }

            // Remove streaming message if active
            if (isStreaming) finishStreaming();
            removeTypingIndicator();

            var totalSections = sections.length;
            var currentIdx = 0;
            var sectionState = sections.map(function() { return { selected: new Set(), customText: '' }; });

            var card = document.createElement('div');
            card.className = 'ask-user-card';

            var sectionEls = [];
            sections.forEach(function(sec, sIdx) {
                var sectionDiv = document.createElement('div');
                sectionDiv.className = 'ask-user-section' + (sIdx === 0 ? ' active' : '');

                var hdr = document.createElement('div');
                hdr.className = 'ask-user-section-header';
                var h4 = document.createElement('h4');
                h4.textContent = sec.question;
                hdr.appendChild(h4);
                if (totalSections > 1) {
                    var badge = document.createElement('span');
                    badge.className = 'ask-user-section-badge';
                    badge.textContent = (sIdx + 1) + ' / ' + totalSections;
                    hdr.appendChild(badge);
                }
                sectionDiv.appendChild(hdr);

                if (sec.context) {
                    var ctx = document.createElement('div');
                    ctx.className = 'ask-user-section-context';
                    ctx.textContent = sec.context;
                    sectionDiv.appendChild(ctx);
                }
                var hint = document.createElement('div');
                hint.className = 'ask-user-section-hint';
                hint.textContent = 'Select all that apply';
                sectionDiv.appendChild(hint);

                var list = document.createElement('ul');
                list.className = 'ask-user-options-list';

                var customInput = document.createElement('input');
                customInput.type = 'text';
                customInput.className = 'ask-user-custom-input';
                customInput.placeholder = 'Type your answer...';
                customInput.style.display = 'none';
                customInput.addEventListener('input', function() { sectionState[sIdx].customText = customInput.value; });

                var allOpts = (sec.suggestions || []).concat(['Something else']);
                allOpts.forEach(function(opt, oIdx) {
                    var isSomethingElse = oIdx === allOpts.length - 1;
                    var row = document.createElement('li');
                    row.className = 'ask-user-option-row';
                    var checkbox = document.createElement('span');
                    checkbox.className = 'ask-user-option-checkbox';
                    var label = document.createElement('span');
                    label.className = 'ask-user-option-label';
                    label.textContent = opt;
                    row.appendChild(checkbox);
                    row.appendChild(label);
                    list.appendChild(row);
                    if (isSomethingElse) list.appendChild(customInput);

                    row.addEventListener('click', function() {
                        var state = sectionState[sIdx];
                        var isChecked = row.classList.toggle('checked');
                        checkbox.textContent = isChecked ? '✓' : '';
                        if (isChecked) state.selected.add(opt); else state.selected.delete(opt);
                        if (isSomethingElse) {
                            customInput.style.display = isChecked ? 'block' : 'none';
                            if (isChecked) customInput.focus();
                        }
                        updateFooter();
                    });
                });

                sectionDiv.appendChild(list);
                sectionEls.push(sectionDiv);
                card.appendChild(sectionDiv);
            });

            // Footer
            var footer = document.createElement('div');
            footer.className = 'ask-user-footer';
            var countSpan = document.createElement('span');
            countSpan.className = 'ask-user-count';
            var footerBtns = document.createElement('div');
            footerBtns.className = 'ask-user-footer-buttons';
            var skipBtn = document.createElement('button');
            skipBtn.className = 'ask-user-skip-btn';
            skipBtn.textContent = 'Skip';
            var nextBtn = document.createElement('button');
            nextBtn.className = 'ask-user-next-btn';
            nextBtn.textContent = 'Next';
            var submitBtn = document.createElement('button');
            submitBtn.className = 'ask-user-submit-btn';
            submitBtn.textContent = 'Submit';

            footerBtns.appendChild(skipBtn);
            if (totalSections > 1) footerBtns.appendChild(nextBtn);
            footerBtns.appendChild(submitBtn);
            footer.appendChild(countSpan);
            footer.appendChild(footerBtns);
            card.appendChild(footer);

            function showSection(idx) {
                currentIdx = idx;
                sectionEls.forEach(function(el, i) { el.classList.toggle('active', i === idx); });
                updateFooter();
            }

            function updateFooter() {
                if (!sectionState[currentIdx]) return;
                var n = sectionState[currentIdx].selected.size;
                countSpan.textContent = n + ' selected';
                var isLast = currentIdx === totalSections - 1;
                if (totalSections > 1) {
                    nextBtn.style.display = isLast ? 'none' : '';
                    nextBtn.disabled = n === 0;
                }
                submitBtn.style.display = isLast ? '' : 'none';
                submitBtn.disabled = n === 0;
            }
            updateFooter();

            function dismissCard(message) {
                card.classList.add('dismissed');
                // If the AI is still streaming, stop it first and queue
                // the answer to send once the stream finishes.
                if (isStreaming && socket && socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: 'stop_generation' }));
                    var waitForIdle = setInterval(function() {
                        if (!isStreaming) {
                            clearInterval(waitForIdle);
                            sendMessage(message);
                        }
                    }, 150);
                    // Safety timeout — send anyway after 5s
                    setTimeout(function() { clearInterval(waitForIdle); sendMessage(message); }, 5000);
                } else {
                    sendMessage(message);
                }
            }

            nextBtn.addEventListener('click', function() {
                if (currentIdx < totalSections - 1) showSection(currentIdx + 1);
                scrollToBottom();
            });

            submitBtn.addEventListener('click', function() {
                var parts = [];
                sectionState.forEach(function(state, sIdx) {
                    var choices = [];
                    state.selected.forEach(function(s) {
                        if (s === 'Something else') {
                            var custom = state.customText.trim();
                            if (custom) choices.push(custom);
                        } else {
                            choices.push(s);
                        }
                    });
                    if (choices.length > 0) {
                        if (totalSections > 1) {
                            var answerText = choices.length === 1
                                ? choices[0]
                                : choices.map(function(c) { return '- ' + c; }).join('\n   ');
                            parts.push('Q: ' + sections[sIdx].question + '\nA: ' + answerText);
                        } else {
                            parts.push(choices.join(', '));
                        }
                    }
                });
                if (parts.length === 0) return;
                dismissCard(parts.join('\n\n'));
            });

            skipBtn.addEventListener('click', function() {
                dismissCard('Skip — proceed with your best judgment');
            });

            messageContainer.appendChild(card);
            scrollToBottom();
            return;
        }

        if (ntype === 'instant_app_ready') {
            const url = data.preview_url;
            const appName = data.app_name || 'App';
            buildBusy = false;
            updateSendBtn();
            if (url) {
                loadPreview(url);
                setStatus('running', appName + ' is live');
            }
            appendBuildNotice(data.message || 'App is ready!', 'running');
            showActionsIfReady();

            // Update header status badge
            const statusBadge = document.querySelector('.instant-app-status-badge');
            if (statusBadge) {
                statusBadge.className = 'instant-app-status-badge running';
                statusBadge.textContent = 'running';
            }
            // Update sidebar app status
            const activeSidebarItem = document.querySelector('.sidebar-app-item.active .sidebar-app-status');
            if (activeSidebarItem) {
                activeSidebarItem.className = 'sidebar-app-status running';
                activeSidebarItem.textContent = 'running';
            }
        }
    }

    // ---- Chat UI (matching main chat patterns) ----

    function clearWelcome() {
        const welcome = messageContainer.querySelector('.welcome-message');
        if (welcome) welcome.remove();
    }

    function escapeHtml(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function addMessageToChat(role, content) {
        clearWelcome();

        // Create message element — same structure as chat.js
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${role}`;

        // Create message content
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        contentDiv.setAttribute('data-raw-content', content);

        if (role === 'assistant' || role === 'system') {
            contentDiv.innerHTML = marked.parse(content);
        } else {
            contentDiv.innerHTML = escapeHtml(content);
        }

        // Create copy button
        const copyButton = document.createElement('button');
        copyButton.className = 'message-copy-btn';
        copyButton.innerHTML = '<i class="fas fa-copy"></i>';
        copyButton.title = 'Copy message';
        copyButton.onclick = function() {
            copyMessageToClipboard(content, this);
        };

        // Create message actions container
        const messageActions = document.createElement('div');
        messageActions.className = 'message-actions';
        messageActions.appendChild(copyButton);

        // Append elements
        messageDiv.appendChild(contentDiv);
        messageDiv.appendChild(messageActions);
        messageContainer.appendChild(messageDiv);

        scrollToBottom();
        return messageDiv;
    }

    function copyMessageToClipboard(content, button) {
        navigator.clipboard.writeText(content).then(() => {
            button.classList.add('copied');
            button.innerHTML = '<i class="fas fa-check"></i>';
            setTimeout(() => {
                button.classList.remove('copied');
                button.innerHTML = '<i class="fas fa-copy"></i>';
            }, 2000);
        });
    }

    let lastBuildNoticeMsg = '';
    let pendingTextBreak = false;
    function appendBuildNotice(message, status, errorType) {
        // Capture the GitHub repo URL from the auto-sync notice so the GitHub button
        // updates to "open repo" without needing a page refresh.
        const ghMatch = /synced to GitHub:\s*(https?:\/\/\S+)/i.exec(message || '');
        if (ghMatch) { config.githubRepoUrl = ghMatch[1]; if (typeof updateGithubBtn === 'function') updateGithubBtn(); }

        // Dedupe consecutive identical transient notices — the orchestrator polls
        // get_instant_app_status repeatedly, each re-emitting "<app> status: building".
        if (status !== 'running' && status !== 'error' && message === lastBuildNoticeMsg) return;
        lastBuildNoticeMsg = message;

        // If the assistant is mid-stream, a tool/status notice means it paused to call
        // a tool — break the next text into a new paragraph so sentences don't run
        // together (e.g. "...check again.The sandbox seems hung...").
        if (isStreaming) pendingTextBreak = true;

        // When a terminal status arrives, resolve all prior spinning notices
        if (status === 'running' || status === 'error') {
            messageContainer.querySelectorAll('.instant-build-notice.notice-building').forEach(prev => {
                prev.classList.remove('notice-building');
                prev.classList.add('notice-past');
                const spinner = prev.querySelector('.spinner-small');
                if (spinner) spinner.outerHTML = '<i class="fas fa-circle" style="font-size:5px;opacity:0.4;margin:0 2px"></i>';
            });
        }

        const el = document.createElement('div');
        el.className = 'instant-build-notice';
        if (status === 'error') el.classList.add('notice-error');
        else if (status === 'running') el.classList.add('notice-done');
        else if (status === 'done') el.classList.add('notice-past');
        else el.classList.add('notice-building');

        const icon = status === 'error' ? '<i class="fas fa-times-circle" style="font-size:10px"></i>'
                   : status === 'running' ? '<i class="fas fa-check-circle" style="font-size:10px"></i>'
                   : '<i class="fas fa-circle" style="font-size:5px;opacity:0.4;margin:0 2px"></i>';

        let content;
        if (status === 'error' && errorType === 'no_credentials') {
            content = `${escapeHtml(message)} <a href="/settings/integrations" style="color:inherit;text-decoration:underline;font-weight:600;">Go to Settings →</a>`;
        } else {
            content = escapeHtml(message);
        }
        el.innerHTML = `${icon}<span>${content}</span>`;
        messageContainer.appendChild(el);
        scrollToBottom();
    }

    function appendSearchNotice() {
        // Remove any existing search notice (only show the latest)
        const existing = messageContainer.querySelector('.instant-search-notice');
        if (existing) existing.remove();

        const el = document.createElement('div');
        el.className = 'instant-build-notice instant-search-notice notice-building';
        el.innerHTML = '<span class="spinner-small"></span><span>Searching the web\u2026</span>';
        messageContainer.appendChild(el);
        scrollToBottom();
    }



    function startStreaming() {
        isStreaming = true;
        pendingTextBreak = false;
        currentRawContent = '';
        clearWelcome();
        removeTypingIndicator();
        // Remove search/research notices once the model starts responding
        const searchNotice = messageContainer.querySelector('.instant-search-notice');
        if (searchNotice) searchNotice.remove();

        // Create the same message structure as addMessageToChat
        currentAssistantEl = document.createElement('div');
        currentAssistantEl.className = 'message assistant';

        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        contentDiv.setAttribute('data-raw-content', '');
        currentAssistantEl.appendChild(contentDiv);

        messageContainer.appendChild(currentAssistantEl);
        streamBusy = true;
        updateSendBtn();
    }

    function appendChunk(text) {
        if (!currentAssistantEl) startStreaming();
        // Insert a paragraph break if a tool call interrupted the stream before this text.
        if (pendingTextBreak) {
            pendingTextBreak = false;
            if (currentRawContent && !/\n\s*$/.test(currentRawContent)) currentRawContent += '\n\n';
        }
        currentRawContent += text;

        const contentDiv = currentAssistantEl.querySelector('.message-content');
        contentDiv.setAttribute('data-raw-content', currentRawContent);
        contentDiv.innerHTML = marked.parse(currentRawContent);

        scrollToBottom();
    }

    function finishStreaming() {
        if (currentAssistantEl) {
            // Add copy button + actions on completion
            const rawContent = currentRawContent;
            const copyButton = document.createElement('button');
            copyButton.className = 'message-copy-btn';
            copyButton.innerHTML = '<i class="fas fa-copy"></i>';
            copyButton.title = 'Copy message';
            copyButton.onclick = function() {
                copyMessageToClipboard(rawContent, this);
            };

            const messageActions = document.createElement('div');
            messageActions.className = 'message-actions';
            messageActions.appendChild(copyButton);
            currentAssistantEl.appendChild(messageActions);
        }

        removeTypingIndicator();
        isStreaming = false;
        currentAssistantEl = null;
        currentRawContent = '';
        // Reflect the real turn state (streamBusy is only cleared on is_final),
        // so intermediate bubble-closing doesn't flip the button back to Send early.
        updateSendBtn();
        chatInput.focus();
    }

    function scrollToBottom() {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // ---- Typing Indicator ----

    function showTypingIndicator() {
        removeTypingIndicator();
        const indicator = document.createElement('div');
        indicator.className = 'typing-indicator';
        indicator.id = 'typing-indicator';
        indicator.innerHTML =
            '<span class="typing-indicator-label">Thinking</span>' +
            '<span class="typing-indicator-dot"></span>' +
            '<span class="typing-indicator-dot"></span>' +
            '<span class="typing-indicator-dot"></span>';
        messageContainer.appendChild(indicator);
        scrollToBottom();
    }

    function removeTypingIndicator() {
        const indicator = document.getElementById('typing-indicator');
        if (indicator) indicator.remove();
    }

    // Send an approval message, stopping any in-flight stream first.
    function sendApproval(msg) {
        if (isStreaming && socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'stop_generation' }));
            const wait = setInterval(function () { if (!isStreaming) { clearInterval(wait); sendMessage(msg); } }, 150);
            setTimeout(function () { clearInterval(wait); sendMessage(msg); }, 5000);
        } else {
            sendMessage(msg);
        }
    }

    // STEP 1 card — PLAN & architecture only (no design). Approve → moves to design.
    function resetQaBtn() {
        var b = document.getElementById('qa-run-btn');
        if (b) { b.disabled = false; b.innerHTML = '<i class="fas fa-play"></i> Run QA tests'; }
    }

    function runQa() {
        var appId = config.currentAppId;
        if (!appId) return;
        var b = document.getElementById('qa-run-btn');
        var results = document.getElementById('qa-results');
        var summary = document.getElementById('qa-summary');
        if (b) { b.disabled = true; b.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Running…'; }
        if (summary) summary.textContent = '';
        if (results) results.innerHTML = '<div class="qa-empty-state" style="text-align:center;opacity:0.6;padding:2rem;">Booting cloud browser…</div>';
        fetch('/api/instant/apps/' + appId + '/qa', { method: 'POST', credentials: 'same-origin' })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (d && d.error) {
                    if (results) results.innerHTML = '<div class="qa-empty-state" style="text-align:center;color:#f87171;padding:2rem;">' + escapeHtml(d.error) + '</div>';
                    resetQaBtn();
                }
            })
            .catch(function () {
                if (results) results.innerHTML = '<div class="qa-empty-state" style="text-align:center;color:#f87171;padding:2rem;">Failed to start QA.</div>';
                resetQaBtn();
            });
    }

    function renderQaScreen(s) {
        s = s || {};
        var ok = !!s.ok;
        var color = ok ? '#34d399' : '#f87171';
        return '<div style="border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:10px;margin-bottom:10px;background:rgba(255,255,255,0.02);">'
            + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:0.85rem;">'
            + '<code style="color:#cbd5e1;">' + escapeHtml(s.route || '/') + '</code>'
            + '<span style="font-weight:700;color:' + color + ';">' + (ok ? 'PASS' : 'FAIL') + '</span>'
            + (s.httpStatus ? '<span style="opacity:.45;margin-left:auto;">HTTP ' + s.httpStatus + '</span>' : '')
            + '</div>'
            + (s.explainer ? '<div style="font-size:0.82rem;color:rgba(255,255,255,0.85);margin-bottom:4px;line-height:1.45;">' + escapeHtml(s.explainer) + '</div>' : '')
            + (s.observation ? '<div style="font-size:0.73rem;color:rgba(255,255,255,0.45);margin-bottom:6px;line-height:1.4;">' + escapeHtml(s.observation) + '</div>' : '')
            + (s.screenshotUrl
                ? '<a href="' + escapeHtml(s.screenshotUrl) + '" target="_blank" rel="noopener"><img src="' + escapeHtml(s.screenshotUrl) + '" loading="lazy" style="width:100%;border-radius:6px;border:1px solid rgba(255,255,255,0.08);display:block;"></a>'
                : '<div style="opacity:.5;font-size:0.8rem;">No screenshot captured</div>')
            + '</div>';
    }

    function handleQaNotification(data) {
        var results = document.getElementById('qa-results');
        var summary = document.getElementById('qa-summary');
        if (summary && data.message) summary.textContent = data.message;
        if (Array.isArray(data.results)) {
            // Final event: fill the QA panel + finalize the live chat card.
            if (results) results.innerHTML = data.results.map(renderQaScreen).join('') || '<div class="qa-empty-state" style="text-align:center;opacity:0.6;padding:2rem;">No screens tested.</div>';
            resetQaBtn();
            qaCardFinish(data);
        } else if (data.screen) {
            if (results) {
                var empty = results.querySelector('.qa-empty-state');
                if (empty) empty.remove();
                results.insertAdjacentHTML('beforeend', renderQaScreen(data.screen));
                results.scrollTop = results.scrollHeight;
            }
            qaCardRow(data.screen); // stream the screen into the chat card
        } else {
            // Initial "Testing N screens…" — show a live card in the chat immediately.
            qaCardStart(data.message);
        }
    }

    // ── Live QA card in the chat: appears on start, streams each screen, finalizes ──
    var _qaCard = null, _qaRows = null;

    function renderQaChatRow(s) {
        var color = s.ok ? '#34d399' : '#f87171';
        var img = s.screenshotUrl
            ? '<a href="' + escapeHtml(s.screenshotUrl) + '" target="_blank" rel="noopener"><img src="' + escapeHtml(s.screenshotUrl) + '" loading="lazy" style="width:120px;height:80px;object-fit:cover;object-position:top;border-radius:6px;border:1px solid rgba(255,255,255,0.08);display:block;flex-shrink:0;"></a>'
            : '<div style="width:120px;height:80px;border-radius:6px;background:rgba(255,255,255,0.04);display:flex;align-items:center;justify-content:center;opacity:.4;font-size:0.7rem;flex-shrink:0;">no shot</div>';
        return '<div style="display:flex;gap:10px;padding:10px 0;border-top:1px solid rgba(255,255,255,0.06);">'
            + img
            + '<div style="min-width:0;flex:1;">'
            + '<div style="display:flex;align-items:center;gap:8px;font-size:0.82rem;">'
            + '<code style="color:#cbd5e1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(s.route || '/') + '</code>'
            + '<span style="font-weight:700;color:' + color + ';margin-left:auto;">' + (s.ok ? 'PASS' : 'FAIL') + '</span>'
            + '</div>'
            + (s.explainer ? '<div style="font-size:0.8rem;color:rgba(255,255,255,0.85);margin-top:4px;line-height:1.45;">' + escapeHtml(s.explainer) + '</div>' : '')
            + (s.observation ? '<div style="font-size:0.71rem;color:rgba(255,255,255,0.42);margin-top:3px;line-height:1.4;">' + escapeHtml(s.observation) + '</div>' : '')
            + '</div></div>';
    }

    function qaCardStart(message) {
        var card = document.createElement('div');
        card.className = 'qa-chat-card';
        card.style.cssText = 'border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:14px;margin:10px 0;background:rgba(255,255,255,0.02);';
        card.innerHTML =
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">'
            + '<i class="fas fa-vial" style="color:#a78bfa;"></i><span style="font-weight:700;">QA results</span>'
            + '<span class="qa-card-status" style="margin-left:auto;font-size:0.82rem;color:rgba(255,255,255,0.6);"><i class="fas fa-spinner fa-spin"></i> ' + escapeHtml(message || 'running…') + '</span>'
            + '</div><div class="qa-card-rows"></div>';
        messageContainer.appendChild(card);
        _qaCard = card;
        _qaRows = card.querySelector('.qa-card-rows');
        scrollToBottom();
    }

    function qaCardRow(s) {
        if (!_qaRows) qaCardStart('running…');
        _qaRows.insertAdjacentHTML('beforeend', renderQaChatRow(s));
        scrollToBottom();
    }

    function qaCardFinish(data) {
        var screens = Array.isArray(data.results) ? data.results : [];
        if (!_qaCard) qaCardStart(data.message || 'done');
        var statusEl = _qaCard.querySelector('.qa-card-status');
        if (screens.length) {
            var passed = data.passed != null ? data.passed : screens.filter(function (s) { return s.ok; }).length;
            var headColor = (screens.length - passed) === 0 ? '#34d399' : '#f87171';
            // Re-render rows now that they carry the AI explainers.
            if (_qaRows) _qaRows.innerHTML = screens.map(renderQaChatRow).join('');
            if (statusEl) { statusEl.style.color = headColor; statusEl.innerHTML = passed + '/' + screens.length + ' passed'; }
            // Overall AI summary above the rows.
            if (data.overall && _qaRows && !_qaCard.querySelector('.qa-card-overall')) {
                var ov = document.createElement('div');
                ov.className = 'qa-card-overall';
                ov.style.cssText = 'font-size:0.82rem;color:rgba(255,255,255,0.8);margin:2px 0 8px;line-height:1.5;';
                ov.textContent = data.overall;
                _qaRows.parentNode.insertBefore(ov, _qaRows);
            }
        } else if (statusEl) {
            statusEl.style.color = '#f87171';
            statusEl.textContent = data.message || 'No screens tested.';
        }
        _qaCard = null;
        _qaRows = null;
        scrollToBottom();
    }

    // Re-render the last saved QA report after the conversation history loads, so a
    // page refresh keeps the QA card (it's a transient WS card otherwise).
    var _persistedQaRendered = false;
    function maybeRenderPersistedQa() {
        if (_persistedQaRendered) return;
        var rep = config.testReport;
        if (!rep || !Array.isArray(rep.screens) || !rep.screens.length) return;
        _persistedQaRendered = true;
        qaCardFinish({ results: rep.screens, passed: rep.passed, failed: rep.failed, overall: rep.overall });
    }

    function renderPlanProposal(d) {
        d = d || {};
        if (isStreaming) finishStreaming();
        removeTypingIndicator();

        const sections = Array.isArray(d.sections) ? d.sections : [];
        const summary = d.summary || '';
        const appName = d.app_name || 'Your app';
        const projectType = d.project_type || 'webapp';
        const stack = d.stack || '';
        const changes = Array.isArray(d.change_log) ? d.change_log : [];

        const sectionsHtml = sections.map(function (s) {
            return '<li><strong>' + escapeHtml(s.title || '') + '</strong>'
                + (s.description ? ' — ' + escapeHtml(s.description) : '') + '</li>';
        }).join('');
        const changesHtml = changes.map(function (c) { return '<li>' + escapeHtml(c) + '</li>'; }).join('');

        const card = document.createElement('div');
        card.className = 'design-proposal-card';
        card.innerHTML =
            '<div class="design-proposal-header">'
            + '<span class="design-proposal-title">Plan &amp; Architecture</span>'
            + '<span class="design-proposal-badge">' + escapeHtml(projectType) + '</span>'
            + '</div>'
            + '<div class="design-proposal-appname">' + escapeHtml(appName) + '</div>'
            + (summary ? '<div class="design-proposal-summary">' + escapeHtml(summary) + '</div>' : '')
            + (stack ? '<div class="design-proposal-meta"><span><b>Stack:</b> ' + escapeHtml(stack) + '</span></div>' : '')
            + (sectionsHtml ? '<div class="design-proposal-section-title">Sections &amp; features</div><ul class="design-proposal-sections">' + sectionsHtml + '</ul>' : '')
            + (changesHtml ? '<div class="design-proposal-section-title">Change log</div><ul class="design-proposal-sections">' + changesHtml + '</ul>' : '')
            + '<div class="design-proposal-footer">'
            + '<button class="design-proposal-tweak">Request changes</button>'
            + '<button class="design-proposal-approve">Approve plan</button>'
            + '</div>';

        const approveBtn = card.querySelector('.design-proposal-approve');
        const tweakBtn = card.querySelector('.design-proposal-tweak');
        approveBtn.addEventListener('click', function () {
            card.classList.add('dismissed');
            approveBtn.disabled = true; tweakBtn.disabled = true;
            sendApproval('Approved the plan — now show me the design.');
        });
        tweakBtn.addEventListener('click', function () {
            if (chatInput) { chatInput.focus(); chatInput.placeholder = 'What should change in the plan? (sections, features, flow...)'; }
        });
        messageContainer.appendChild(card);
        scrollToBottom();
    }

    // STEP 2 card — DESIGN only (palette/fonts/style). Approve → build.
    function renderDesignProposal(d) {
        d = d || {};
        if (isStreaming) finishStreaming();
        removeTypingIndicator();

        const palette = d.palette || {};
        const colors = palette.colors || {};
        const fonts = d.fonts || {};
        const appName = d.app_name || 'Your app';
        const style = d.style || '';

        const swatchOrder = ['primary', 'secondary', 'accent', 'background', 'text', 'border'];
        const swatchesHtml = swatchOrder.filter(function (k) { return colors[k]; }).map(function (k) {
            return '<div class="design-swatch" title="' + k + ': ' + colors[k] + '">'
                + '<span class="design-swatch-chip" style="background:' + colors[k] + '"></span>'
                + '<span class="design-swatch-label">' + k + '</span></div>';
        }).join('');

        const card = document.createElement('div');
        card.className = 'design-proposal-card';
        card.innerHTML =
            '<div class="design-proposal-header">'
            + '<span class="design-proposal-title">Design</span>'
            + '</div>'
            + '<div class="design-proposal-appname">' + escapeHtml(appName) + '</div>'
            + '<div class="design-swatches">' + swatchesHtml + '</div>'
            + '<div class="design-proposal-meta">'
            + '<span><b>Palette:</b> ' + escapeHtml(palette.name || '') + '</span>'
            + '<span><b>Fonts:</b> ' + escapeHtml((fonts.heading || '') + (fonts.body && fonts.body !== fonts.heading ? ' / ' + fonts.body : '')) + '</span>'
            + '<span><b>Style:</b> ' + escapeHtml(style) + '</span>'
            + '</div>'
            + '<div class="design-proposal-footer">'
            + '<button class="design-proposal-tweak">Request changes</button>'
            + '<button class="design-proposal-approve">Approve &amp; build</button>'
            + '</div>';

        const approveBtn = card.querySelector('.design-proposal-approve');
        const tweakBtn = card.querySelector('.design-proposal-tweak');
        approveBtn.addEventListener('click', function () {
            card.classList.add('dismissed');
            approveBtn.disabled = true; tweakBtn.disabled = true;
            sendApproval('Approved the design — build it now.');
        });
        tweakBtn.addEventListener('click', function () {
            if (chatInput) { chatInput.focus(); chatInput.placeholder = 'What would you like to change? (colors, fonts, style...)'; }
        });
        messageContainer.appendChild(card);
        scrollToBottom();
    }

    // ---- Send message ----

    window.sendMessage = sendMessage;
    function sendMessage(text) {
        if (!text.trim() && !window.instantAttachedFile) return;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;

        const displayText = text || `Attached file: ${window.instantAttachedFile?.name || ''}`;
        addMessageToChat('user', displayText);
        showTypingIndicator();
        streamBusy = true;
        updateSendBtn();

        const payload = {
            type: 'message',
            message: text,
            conversation_id: conversationId,
            instant_mode: true,
        };
        if (projectId) payload.project_id = projectId;
        if (window.instantAttachedFile) {
            payload.file_data = {
                name: window.instantAttachedFile.name,
                type: window.instantAttachedFile.type,
                size: window.instantAttachedFile.size,
            };
            if (window.instantAttachedFile.id) payload.file_data.id = window.instantAttachedFile.id;
            window.instantAttachedFile = null;
            const indicator = document.querySelector('.instant-file-attachment');
            if (indicator) indicator.remove();
        }
        socket.send(JSON.stringify(payload));
    }

    chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        // While the agent is working, the button is a Stop button.
        if (streamBusy || buildBusy) { stopGeneration(); return; }
        const text = chatInput.value.trim();
        if (!text && !window.instantAttachedFile) return;
        chatInput.value = '';
        chatInput.style.height = 'auto';
        sendMessage(text);
    });

    // ---- File Upload ----
    const fileUploadBtn = document.getElementById('file-upload-btn');
    const fileUploadInput = document.getElementById('file-upload-input');
    const recordAudioBtn = document.getElementById('record-audio-btn');

    async function uploadFileToServer(file) {
        const formData = new FormData();
        formData.append('file', file);
        if (conversationId) formData.append('conversation_id', conversationId);

        const resp = await fetch(`/api/files/upload?_=${Date.now()}`, {
            method: 'POST',
            headers: {
                'X-CSRFToken': getCsrfToken(),
                'X-Requested-With': 'XMLHttpRequest',
            },
            body: formData,
            credentials: 'same-origin',
        });
        if (!resp.ok) throw new Error(`Upload failed: HTTP ${resp.status}`);
        return resp.json();
    }

    function renderAttachedFileIndicator(fileInfo) {
        const existing = document.querySelector('.instant-file-attachment');
        if (existing) existing.remove();

        const indicator = document.createElement('div');
        indicator.className = 'instant-file-attachment uploaded';
        indicator.innerHTML = `
            <i class="fas fa-paperclip"></i>
            <span>${escapeHtml(fileInfo.name)}</span>
            <button type="button" class="instant-file-remove" title="Remove"><i class="fas fa-times"></i></button>
        `;

        const inputWrapper = document.querySelector('.input-wrapper');
        inputWrapper.insertBefore(indicator, inputWrapper.firstChild);
        indicator.querySelector('.instant-file-remove').addEventListener('click', () => {
            window.instantAttachedFile = null;
            indicator.remove();
        });
    }

    if (fileUploadBtn && fileUploadInput) {
        fileUploadBtn.addEventListener('click', () => fileUploadInput.click());

        fileUploadInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            fileUploadInput.value = '';

            // Remove existing indicator
            const existing = document.querySelector('.instant-file-attachment');
            if (existing) existing.remove();

            // Show uploading indicator
            const indicator = document.createElement('div');
            indicator.className = 'instant-file-attachment uploading';
            indicator.innerHTML = `<i class="fas fa-sync fa-spin"></i><span>Uploading ${escapeHtml(file.name)}...</span>`;
            const inputWrapper = document.querySelector('.input-wrapper');
            inputWrapper.insertBefore(indicator, inputWrapper.firstChild);

            // Upload via REST API
            try {
                const data = await uploadFileToServer(file);

                window.instantAttachedFile = {
                    file, name: file.name, type: file.type, size: file.size,
                    id: data.id || null,
                };

                indicator.remove();
                renderAttachedFileIndicator(window.instantAttachedFile);
            } catch (err) {
                console.error('[Instant] File upload error:', err);
                // Still allow attaching without server-side upload
                window.instantAttachedFile = { file, name: file.name, type: file.type, size: file.size };
                indicator.remove();
                renderAttachedFileIndicator(window.instantAttachedFile);
            }
        });
    }

    // ---- Model + Role settings ----
    document.querySelectorAll('#model-submenu .submenu-option').forEach(option => {
        option.addEventListener('click', async () => {
            if (option.classList.contains('disabled')) return;
            const modelKey = option.dataset.value;
            if (!modelKey) return;
            try {
                await fetch('/api/settings/model', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ modelKey }),
                });
            } catch (err) {
                console.warn('[Instant] Failed to persist model selection:', err);
            }
            document.querySelectorAll('#model-submenu .submenu-option').forEach(btn => btn.classList.remove('selected'));
            option.classList.add('selected');
            const label = option.querySelector('span')?.textContent?.trim() || modelKey;
            const currentModelLeft = document.getElementById('current-model-left');
            if (currentModelLeft) currentModelLeft.textContent = label;
        });
    });

    document.querySelectorAll('#role-submenu .submenu-option').forEach(option => {
        option.addEventListener('click', async () => {
            const role = option.dataset.value;
            if (!role) return;
            try {
                await fetch('/api/settings/role', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ role }),
                });
            } catch (err) {
                console.warn('[Instant] Failed to persist role selection:', err);
            }
            document.querySelectorAll('#role-submenu .submenu-option').forEach(btn => btn.classList.remove('selected'));
            option.classList.add('selected');
            const label = option.querySelector('span')?.textContent?.trim() || 'Analyst';
            const currentRoleLeft = document.getElementById('current-role-left');
            if (currentRoleLeft) currentRoleLeft.textContent = label;
        });
    });

    // ---- Microphone ----
    if (recordAudioBtn) {
        let mediaRecorder = null;
        let chunks = [];
        let recordingStream = null;

        const resetMicButton = () => {
            recordAudioBtn.classList.remove('recording');
            recordAudioBtn.innerHTML = '<i class="fas fa-microphone"></i>';
        };

        const stopStreamTracks = () => {
            if (recordingStream) {
                recordingStream.getTracks().forEach(track => track.stop());
                recordingStream = null;
            }
        };

        recordAudioBtn.addEventListener('click', async () => {
            if (mediaRecorder && mediaRecorder.state === 'recording') {
                mediaRecorder.stop();
                return;
            }

            try {
                recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                mediaRecorder = new MediaRecorder(recordingStream);
                chunks = [];

                mediaRecorder.ondataavailable = (event) => {
                    if (event.data?.size) chunks.push(event.data);
                };

                mediaRecorder.onstop = async () => {
                    stopStreamTracks();
                    resetMicButton();
                    const audioBlob = new Blob(chunks, { type: 'audio/webm' });
                    chunks = [];
                    if (!audioBlob.size) return;

                    const file = new File([audioBlob], `recording_${Date.now()}.webm`, { type: 'audio/webm' });
                    const indicator = document.createElement('div');
                    indicator.className = 'instant-file-attachment uploading';
                    indicator.innerHTML = '<i class="fas fa-sync fa-spin"></i><span>Transcribing recording...</span>';
                    const inputWrapper = document.querySelector('.input-wrapper');
                    inputWrapper.insertBefore(indicator, inputWrapper.firstChild);

                    try {
                        const uploaded = await uploadFileToServer(file);
                        const attachment = {
                            file,
                            name: file.name,
                            type: file.type,
                            size: file.size,
                            id: uploaded.id || null,
                        };

                        let transcript = '';
                        if (attachment.id) {
                            const response = await fetch(`/api/files/transcribe/${attachment.id}`, {
                                credentials: 'same-origin',
                            });
                            if (response.ok) {
                                const data = await response.json();
                                transcript = (data.text || '').trim();
                            }
                        }

                        indicator.remove();
                        if (transcript) {
                            const prefix = chatInput.value.trim();
                            chatInput.value = prefix ? `${prefix}\n${transcript}` : transcript;
                            chatInput.dispatchEvent(new Event('input'));
                            chatInput.focus();
                        } else {
                            window.instantAttachedFile = attachment;
                            renderAttachedFileIndicator(attachment);
                        }
                    } catch (error) {
                        console.warn('[Instant] Audio transcription failed:', error);
                        indicator.remove();
                    }
                };

                mediaRecorder.start();
                recordAudioBtn.classList.add('recording');
                recordAudioBtn.innerHTML = '<i class="fas fa-stop"></i>';
            } catch (error) {
                console.error('[Instant] Microphone access error:', error);
                resetMicButton();
                stopStreamTracks();
                alert('Unable to access microphone. Please check your permissions.');
            }
        });
    }

    // Auto-resize textarea
    chatInput.addEventListener('input', () => {
        chatInput.style.height = 'auto';
        chatInput.style.height = Math.min(chatInput.scrollHeight, 200) + 'px';
    });

    // Enter to send (shift+enter for newline)
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            chatForm.dispatchEvent(new Event('submit'));
        }
    });

    // ---- Preview ----

    // Snake game state — hoisted here because setPreviewState calls stopSnakeGame
    let snakeInterval = null;
    let snakeState = null;
    let snakePaused = false;

    function setPreviewState(state, message) {
        previewPlaceholder.style.display = state === 'placeholder' ? '' : 'none';
        previewBuilding.style.display = state === 'building' ? '' : 'none';
        previewIframe.style.display = state === 'running' ? '' : 'none';
        if (message && buildingMessage) buildingMessage.textContent = message;
        // Start/stop snake game based on building state
        if (state === 'building') startSnakeGame();
        else stopSnakeGame();
    }

    function setStatus(status, text) {
        statusDot.className = 'status-dot ' + status;
        statusText.textContent = text || status;
    }

    function loadPreview(url) {
        // Older apps have the dead apps.magpiecloud.com domain stored; the live
        // domain is apps.mags.run. Rewrite so stale URLs still render.
        url = (url || '').replace(/\.apps\.magpiecloud\.com/i, '.apps.mags.run');
        previewIframe.src = url;
        setPreviewState('running');
        // Compact "Open" link instead of the full URL bar (declutters the toolbar).
        if (previewUrlText) previewUrlText.textContent = url.replace(/^https?:\/\//, '');
        if (previewOpenBtn) { previewOpenBtn.href = url; previewOpenBtn.style.display = ''; previewOpenBtn.title = url; }
        showActionsIfReady();
    }

    // ---- Rebuild & Refresh ----
    if (previewRefreshBtn) {
        previewRefreshBtn.addEventListener('click', () => {
            const appId = config.currentAppId;
            if (!appId) return;
            previewRefreshBtn.classList.add('refreshing');
            previewRefreshBtn.disabled = true;

            const url = (standaloneMode || !projectId)
                ? `/api/instant/apps/${appId}/rebuild/`
                : `/api/instant/${projectId}/apps/${appId}/rebuild/`;

            fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRFToken': getCsrfToken() } })
                .then(r => r.json())
                .then(data => {
                    // Wait a moment for server to start, then reload iframe
                    setTimeout(() => {
                        if (previewIframe.src) previewIframe.src = previewIframe.src;
                        previewRefreshBtn.classList.remove('refreshing');
                        previewRefreshBtn.disabled = false;
                    }, 4000);
                })
                .catch(err => {
                    console.warn('[Instant] Rebuild error:', err);
                    previewRefreshBtn.classList.remove('refreshing');
                    previewRefreshBtn.disabled = false;
                });
        });
    }

    // Viewport toggle
    document.querySelectorAll('.viewport-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.viewport-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const vp = btn.dataset.viewport;
            previewIframe.className = 'instant-preview-iframe' + (vp !== 'desktop' ? ' viewport-' + vp : '');
        });
    });

    // ---- Draggable Divider ----

    const divider = document.getElementById('instant-divider');
    const chatPanel = document.querySelector('.instant-chat-panel');
    const instantMain = document.querySelector('.instant-main');
    const STORAGE_KEY = 'instant-panel-width';
    const MIN_CHAT = 300;
    const MAX_CHAT_RATIO = 0.6; // max 60% of available space

    function initPanelWidth() {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
            const w = parseInt(saved, 10);
            const max = instantMain.offsetWidth * MAX_CHAT_RATIO;
            chatPanel.style.width = Math.min(Math.max(w, MIN_CHAT), max) + 'px';
        } else {
            chatPanel.style.width = '40%';
        }
    }

    if (divider) {
        let isDragging = false;

        divider.addEventListener('mousedown', (e) => {
            e.preventDefault();
            isDragging = true;
            divider.classList.add('dragging');
            instantMain.classList.add('resizing');
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            const mainRect = instantMain.getBoundingClientRect();
            let newWidth = e.clientX - mainRect.left;
            const maxWidth = mainRect.width * MAX_CHAT_RATIO;
            newWidth = Math.min(Math.max(newWidth, MIN_CHAT), maxWidth);
            chatPanel.style.width = newWidth + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false;
            divider.classList.remove('dragging');
            instantMain.classList.remove('resizing');
            localStorage.setItem(STORAGE_KEY, chatPanel.offsetWidth);
        });
    }

    // ---- Load conversation history via HTTP (fallback if WS doesn't deliver) ----

    function renderHistoryMessages(messages) {
        /**
         * Shared renderer for chat history — used by both WS and HTTP paths.
         * Returns { previewUrl, appName } extracted from build notices.
         */
        // Remove loading indicator
        const loadingIndicator = document.getElementById('chat-loading-indicator');
        if (loadingIndicator) loadingIndicator.remove();

        messageContainer.innerHTML = '';
        let lastPreviewUrl = null;
        let lastAppName = null;

        (messages || []).forEach(msg => {
            const content = msg.content || '';
            if (!content.trim()) return;

            // System messages that are JSON (build notices, env requests)
            if (msg.role === 'system') {
                try {
                    const parsed = JSON.parse(content);
                    if (parsed.type === 'env_var_request') {
                        // Re-render as a live request card (user can still enter the key)
                        appendEnvVarRequest(parsed.key || '', parsed.description || '', parsed.required !== false, parsed.app_id || '');
                        return;
                    }
                    if (parsed.type === 'instant_build_notice') {
                        const historyStatus = (parsed.status === 'building') ? 'done' : parsed.status;
                        appendBuildNotice(parsed.message, historyStatus);
                        if (parsed.status === 'running' && parsed.preview_url) {
                            lastPreviewUrl = parsed.preview_url;
                            lastAppName = parsed.app_name;
                        }
                        return;
                    }
                    if (parsed.type === 'instant_qa_issues') {
                        const findings = Array.isArray(parsed.findings) ? parsed.findings.join('\n') : '';
                        const head = `QA found ${parsed.failed} issue${parsed.failed === 1 ? '' : 's'}` +
                            (parsed.overall ? `: ${parsed.overall}` : '');
                        appendBuildNotice(head + (findings ? '\n' + findings : ''), 'error');
                        return;
                    }
                    if (parsed.type === 'plan_proposal') {
                        renderPlanProposal(parsed);
                        return;
                    }
                    if (parsed.type === 'design_proposal') {
                        // Re-render the design proposal card so it survives a refresh.
                        renderDesignProposal(parsed);
                        return;
                    }
                } catch (_) { /* not JSON — render as normal text */ }
            }

            // Regular user/assistant/system messages
            addMessageToChat(msg.role, content);
        });

        return { previewUrl: lastPreviewUrl, appName: lastAppName };
    }

    function clearLoadingIndicator() {
        const loadingEl = document.getElementById('chat-loading-indicator');
        if (loadingEl) loadingEl.remove();
    }

    function loadConversationHistoryHTTP() {
        if (historyLoaded || !conversationId) {
            clearLoadingIndicator();
            return;
        }
        console.log('[Instant] Loading history via HTTP for conversation', conversationId);
        fetch(`/api/conversations/${conversationId}`, { credentials: 'same-origin' })
            .then(r => {
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                return r.json();
            })
            .then(data => {
                if (historyLoaded) return; // WS beat us
                historyLoaded = true;
                clearLoadingIndicator();
                console.log('[Instant] HTTP loaded', (data.messages || []).length, 'messages');
                const result = renderHistoryMessages(data.messages);
                const resolvedUrl = result.previewUrl || config.previewUrl;
                if (resolvedUrl) {
                    loadPreview(resolvedUrl);
                    setStatus('running', (result.appName || 'App') + ' is live');
                }
                scrollToBottom();
                maybeRenderPersistedQa();
            })
            .catch(err => {
                console.warn('[Instant] HTTP history load error:', err);
                clearLoadingIndicator();
            });
    }

    // ---- App Switcher Dropdown (set up EARLY so it always works) ----
    const appSwitcherBtn = document.getElementById('app-switcher-btn');
    const appSwitcherMenu = document.getElementById('app-switcher-menu');

    if (appSwitcherBtn && appSwitcherMenu) {
        appSwitcherBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = appSwitcherMenu.classList.toggle('open');
            if (isOpen) {
                const rect = appSwitcherBtn.getBoundingClientRect();
                appSwitcherMenu.style.top = (rect.bottom + 4) + 'px';
                appSwitcherMenu.style.right = (window.innerWidth - rect.right) + 'px';
            }
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!appSwitcherMenu.contains(e.target) && !appSwitcherBtn.contains(e.target)) {
                appSwitcherMenu.classList.remove('open');
            }
        });
    }

    // ---- Init ----

    console.log('[Instant] Init config:', JSON.stringify({
        projectId, standaloneMode, appId: config.currentAppId,
        status: config.currentAppStatus, hasPreviewUrl: !!config.previewUrl,
        conversationId
    }));

    try {
        initPanelWidth();
    } catch (e) {
        console.warn('[Instant] initPanelWidth error:', e);
    }

    connectWebSocket();

    // ---- Preview / Logs / Env Tab Toggle ----

    const previewContent = document.getElementById('preview-content');
    const logsContent = document.getElementById('logs-content');
    const envContent = document.getElementById('env-content');
    const designContent = document.getElementById('design-content');
    const qaContent = document.getElementById('qa-content');
    const logsOutput = document.getElementById('logs-output');
    const logsRefreshBtn = document.getElementById('logs-refresh-btn');
    const logsClearBtn = document.getElementById('logs-clear-btn');
    const logsAutoscroll = document.getElementById('logs-autoscroll');
    const viewportToggle = document.getElementById('viewport-toggle');
    let activeTab = 'preview';
    let logsPollingInterval = null;
    let logsOffset = 0;
    let envLoaded = false;

    document.querySelectorAll('.preview-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.preview-tab-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            activeTab = btn.dataset.tab;

            previewContent.style.display = activeTab === 'preview' ? '' : 'none';
            logsContent.style.display = activeTab === 'logs' ? 'flex' : 'none';
            if (envContent) envContent.style.display = activeTab === 'env' ? 'flex' : 'none';
            if (designContent) designContent.style.display = activeTab === 'design' ? '' : 'none';
            if (qaContent) qaContent.style.display = activeTab === 'qa' ? 'flex' : 'none';

            if (viewportToggle) viewportToggle.style.display = (activeTab === 'preview') ? '' : 'none';
            if (previewRefreshBtn) previewRefreshBtn.style.display = (activeTab === 'preview' && config.currentAppId) ? '' : 'none';

            if (activeTab === 'logs') {
                startLogsPolling();
            } else {
                stopLogsPolling();
            }

            if (activeTab === 'env' && !envLoaded) {
                loadEnvVars();
            }
        });
    });

    var qaRunBtn = document.getElementById('qa-run-btn');
    if (qaRunBtn) qaRunBtn.addEventListener('click', runQa);

    function fetchLogs(reset) {
        const appId = config.currentAppId;
        if (!appId) return;
        if (reset) { logsOffset = 0; recentNoisyLines = []; }
        const url = (standaloneMode || !projectId)
            ? `/api/instant/apps/${appId}/logs/?offset=${logsOffset}`
            : `/api/instant/${projectId}/apps/${appId}/logs/?offset=${logsOffset}`;

        fetch(url, { credentials: 'same-origin' })
            .then(r => r.json())
            .then(data => {
                if (data.error && !data.logs) {
                    if (logsOutput.querySelector('.logs-placeholder')) {
                        logsOutput.innerHTML = `<span class="log-warn">${escapeHtml(data.error)}</span>\n`;
                    }
                    return;
                }
                if (data.logs) {
                    // Remove placeholder on first real content
                    const placeholder = logsOutput.querySelector('.logs-placeholder');
                    if (placeholder) placeholder.remove();

                    // Colorize and append
                    const colored = colorizeLogs(data.logs);
                    logsOutput.insertAdjacentHTML('beforeend', colored);

                    if (data.offset) logsOffset = data.offset;

                    // Auto-scroll
                    if (logsAutoscroll && logsAutoscroll.checked) {
                        logsOutput.scrollTop = logsOutput.scrollHeight;
                    }
                }
            })
            .catch(err => {
                console.warn('[Instant] Logs fetch error:', err);
            });
    }

    // Dev-server restart banners (Next.js prints these on every `npm start`, and the
    // build restarts the server many times) flood the log. Suppress repeats of these
    // specific noisy lines while keeping ALL real output. Tracks recently-seen noisy
    // lines across chunks so duplicates from restarts collapse to the first occurrence.
    const NOISY_LOG_RE = /^\s*(▲\s*Next\.js|- Local:|- Network:|✓\s*Ready in|✓\s*Compiled|- Environments?:|▲\s*Next)/i;
    let recentNoisyLines = [];
    function colorizeLogs(text) {
        const out = [];
        for (const raw of escapeHtml(text).split('\n')) {
            const trimmed = raw.trim();
            if (trimmed && NOISY_LOG_RE.test(raw)) {
                if (recentNoisyLines.includes(trimmed)) continue; // already shown — skip the repeat
                recentNoisyLines.push(trimmed);
                if (recentNoisyLines.length > 12) recentNoisyLines.shift();
            }
            if (/error|ERR!|Error/i.test(raw)) out.push(`<span class="log-error">${raw}</span>`);
            else if (/warn|WARN/i.test(raw)) out.push(`<span class="log-warn">${raw}</span>`);
            else if (/ready|compiled|listening|started/i.test(raw)) out.push(`<span class="log-info">${raw}</span>`);
            else out.push(raw);
        }
        return out.join('\n');
    }

    function startLogsPolling() {
        stopLogsPolling();
        fetchLogs(false);
        logsPollingInterval = setInterval(() => fetchLogs(false), 3000);
    }

    function stopLogsPolling() {
        if (logsPollingInterval) {
            clearInterval(logsPollingInterval);
            logsPollingInterval = null;
        }
    }

    if (logsRefreshBtn) {
        logsRefreshBtn.addEventListener('click', () => fetchLogs(true));
    }
    if (logsClearBtn) {
        logsClearBtn.addEventListener('click', () => {
            logsOutput.innerHTML = '<span class="logs-placeholder">Logs cleared.</span>';
            logsOffset = 0;
            recentNoisyLines = [];
        });
    }

    // ---- Env Vars CRUD ----

    function getEnvApiUrl() {
        const appId = config.currentAppId;
        if (!appId) return null;
        if (standaloneMode || !projectId) return `/api/instant/apps/${appId}/env/`;
        return `/api/instant/${projectId}/apps/${appId}/env/`;
    }

    function loadEnvVars() {
        const url = getEnvApiUrl();
        if (!url) return;

        fetch(url, { credentials: 'same-origin' })
            .then(r => r.json())
            .then(data => {
                envLoaded = true;
                renderEnvTable(data.env_vars || {});
            })
            .catch(err => console.warn('[Instant] Env fetch error:', err));
    }

    function renderEnvTable(vars) {
        const table = document.getElementById('env-table');
        const emptyState = document.getElementById('env-empty-state');
        if (!table) return;

        // Remove existing rows
        table.querySelectorAll('.env-row').forEach(r => r.remove());

        const keys = Object.keys(vars);
        if (keys.length === 0) {
            if (emptyState) emptyState.style.display = '';
            return;
        }
        if (emptyState) emptyState.style.display = 'none';

        keys.forEach(key => {
            addEnvRow(key, vars[key], false);
        });
    }

    function addEnvRow(key, value, isNew) {
        const table = document.getElementById('env-table');
        const emptyState = document.getElementById('env-empty-state');
        if (emptyState) emptyState.style.display = 'none';

        const row = document.createElement('div');
        row.className = 'env-row';

        const keyInput = document.createElement('input');
        keyInput.className = 'env-key-input';
        keyInput.type = 'text';
        keyInput.placeholder = 'KEY';
        keyInput.value = key || '';
        if (!isNew && key) {
            keyInput.readOnly = true;
            keyInput.classList.add('readonly');
        }

        const valueInput = document.createElement('input');
        valueInput.className = 'env-value-input';
        valueInput.type = 'password';
        valueInput.placeholder = 'value';
        valueInput.value = value || '';

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'env-value-toggle';
        toggleBtn.innerHTML = '<i class="fas fa-eye"></i>';
        toggleBtn.title = 'Toggle visibility';
        toggleBtn.onclick = () => {
            if (valueInput.type === 'password') {
                valueInput.type = 'text';
                toggleBtn.innerHTML = '<i class="fas fa-eye-slash"></i>';
            } else {
                valueInput.type = 'password';
                toggleBtn.innerHTML = '<i class="fas fa-eye"></i>';
            }
        };

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'env-delete-btn';
        deleteBtn.innerHTML = '<i class="fas fa-trash"></i>';
        deleteBtn.title = 'Remove';
        deleteBtn.onclick = () => {
            row.remove();
            // Show empty state if no rows left
            if (!table.querySelector('.env-row')) {
                if (emptyState) emptyState.style.display = '';
            }
        };

        row.appendChild(keyInput);
        row.appendChild(valueInput);
        row.appendChild(toggleBtn);
        row.appendChild(deleteBtn);
        table.appendChild(row);

        if (isNew) keyInput.focus();
    }

    function collectEnvVars() {
        const rows = document.querySelectorAll('#env-table .env-row');
        const vars = {};
        rows.forEach(row => {
            const key = row.querySelector('.env-key-input').value.trim();
            const value = row.querySelector('.env-value-input').value;
            if (key) vars[key] = value;
        });
        return vars;
    }

    function saveEnvVars() {
        const url = getEnvApiUrl();
        if (!url) return;

        const vars = collectEnvVars();
        fetch(url, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCsrfToken(),
            },
            body: JSON.stringify({ env_vars: vars }),
        })
        .then(r => r.json())
        .then(data => {
            if (data.error) {
                console.error('[Instant] Env save error:', data.error);
                return;
            }
            // Flash the save button green briefly
            const saveBtn = document.getElementById('env-save-btn');
            if (saveBtn) {
                saveBtn.innerHTML = '<i class="fas fa-check"></i> Saved';
                setTimeout(() => { saveBtn.innerHTML = '<i class="fas fa-save"></i> Save'; }, 2000);
            }
            // Reload to normalize
            renderEnvTable(data.env_vars || {});
        })
        .catch(err => console.error('[Instant] Env save error:', err));
    }

    function getCsrfToken() {
        const cookie = document.cookie.split(';').find(c => c.trim().startsWith('csrftoken='));
        return cookie ? cookie.split('=')[1] : '';
    }

    // Wire up env toolbar buttons
    const envAddBtn = document.getElementById('env-add-btn');
    const envSaveBtn = document.getElementById('env-save-btn');
    if (envAddBtn) envAddBtn.addEventListener('click', () => addEnvRow('', '', true));
    if (envSaveBtn) envSaveBtn.addEventListener('click', saveEnvVars);

    // ---- Env Var Request (from AI) ----

    function appendEnvVarRequest(key, description, required, appId) {
        const el = document.createElement('div');
        el.className = 'notice-env-request';
        el.setAttribute('data-env-key', key);

        const reqLabel = required ? 'Required' : 'Optional';
        el.innerHTML = `
            <div class="env-request-header">
                <i class="fas fa-key"></i>
                <span>${reqLabel}: <strong>${escapeHtml(key)}</strong></span>
            </div>
            <div class="env-request-desc">${escapeHtml(description)}</div>
            <div class="env-request-form">
                <input type="password" class="env-request-input" placeholder="Enter value for ${escapeHtml(key)}...">
                <button class="env-request-set-btn">Set</button>
            </div>
        `;

        const input = el.querySelector('.env-request-input');
        const setBtn = el.querySelector('.env-request-set-btn');

        setBtn.addEventListener('click', () => {
            const value = input.value;
            if (!value && required) return;

            // Save to env vars via API
            const resolvedAppId = appId || config.currentAppId;
            if (!resolvedAppId) return;

            const url = (standaloneMode || !projectId)
                ? `/api/instant/apps/${resolvedAppId}/env/`
                : `/api/instant/${projectId}/apps/${resolvedAppId}/env/`;

            // First fetch current vars, then merge
            fetch(url, { credentials: 'same-origin' })
                .then(r => r.json())
                .then(data => {
                    const currentVars = data.env_vars || {};
                    currentVars[key] = value;
                    return fetch(url, {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-CSRFToken': getCsrfToken(),
                        },
                        body: JSON.stringify({ env_vars: currentVars }),
                    });
                })
                .then(r => r.json())
                .then(() => {
                    // Mark as done
                    el.classList.add('notice-done');
                    input.disabled = true;
                    input.type = 'password';
                    setBtn.textContent = 'Set';
                    setBtn.disabled = true;

                    // Notify the AI that the var was set
                    if (socket && socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify({
                            type: 'message',
                            message: `I've set the environment variable \`${key}\`. You can proceed.`,
                            conversation_id: conversationId,
                            instant_mode: true,
                            ...(projectId ? { project_id: projectId } : {}),
                        }));
                        addMessageToChat('user', `I've set the environment variable \`${key}\`. You can proceed.`);
                        showTypingIndicator();
                    }

                    // Reload env tab if it was loaded
                    envLoaded = false;
                })
                .catch(err => console.error('[Instant] Env var set error:', err));
        });

        messageContainer.appendChild(el);
        scrollToBottom();
    }

    // ---- Action Buttons (Export, Download, Delete, Provision DB) ----

    const previewActions = document.getElementById('preview-actions');
    const previewMenuBtn = document.getElementById('preview-menu-btn');
    const previewMenu = document.getElementById('preview-menu');
    const restoreBtn = document.getElementById('preview-restore-btn');
    const downloadBtn = document.getElementById('preview-download-btn');
    const exportGithubBtn = document.getElementById('preview-export-github-btn');
    const deleteAppBtn = document.getElementById('preview-delete-btn');

    // Swap ONLY the leading <i> icon for a loading state — preserves the menu-item label.
    function setItemLoading(btn, loading, iconClass) {
        if (!btn) return;
        btn.disabled = loading;
        const i = btn.querySelector('i');
        if (i) i.className = loading ? 'fas fa-spinner fa-spin' : iconClass;
    }

    // ── Unified "More actions" dropdown menu ──
    function closePreviewMenu() {
        if (previewMenu) previewMenu.classList.remove('open');
        if (previewMenuBtn) previewMenuBtn.setAttribute('aria-expanded', 'false');
    }
    if (previewMenuBtn && previewMenu) {
        previewMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = previewMenu.classList.toggle('open');
            previewMenuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        // Close on outside click or Escape.
        document.addEventListener('click', (e) => {
            if (!previewMenu.contains(e.target) && e.target !== previewMenuBtn) closePreviewMenu();
        });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePreviewMenu(); });
    }

    // Shared restore logic — invoked from BOTH the toolbar button and the ⋮ menu item.
    async function doRestore(triggerEl) {
        const base = getAppApiBase();
        if (!base) return;
        closePreviewMenu();
        if (triggerEl) setItemLoading(triggerEl, true);
        setPreviewState('building', 'Restoring app...');
        setStatus('building', 'Restoring');
        try {
            const resp = await fetch(`${base}/restore`, { method: 'POST', credentials: 'same-origin' });
            const data = await resp.json();
            if (data.error) {
                alert('Restore failed: ' + data.error);
                setStatus('error', 'Error');
            }
            // On success, build progress streams in over WS like a normal build.
        } catch (err) {
            alert('Restore failed: ' + err.message);
        } finally {
            if (triggerEl) setItemLoading(triggerEl, false, 'fas fa-power-off');
        }
    }

    if (restoreBtn) restoreBtn.addEventListener('click', () => doRestore(restoreBtn));
    const restoreTopBtn = document.getElementById('preview-restore-top-btn');
    if (restoreTopBtn) restoreTopBtn.addEventListener('click', () => doRestore(restoreTopBtn));

    function showActionsIfReady() {
        if (config.currentAppId) {
            // Always show the rebuild + restore buttons when we have an app
            if (previewRefreshBtn) previewRefreshBtn.style.display = '';
            if (restoreTopBtn) restoreTopBtn.style.display = '';
            // Show the rest of the action buttons
            if (previewActions) previewActions.style.display = '';
        }
    }

    // Show action buttons immediately for existing apps
    if (config.currentAppId) {
        showActionsIfReady();
    }

    function getAppApiBase() {
        const appId = config.currentAppId;
        if (!appId) return null;
        if (standaloneMode || !projectId) return `/api/instant/apps/${appId}`;
        return `/api/instant/${projectId}/apps/${appId}`;
    }

    if (downloadBtn) {
        downloadBtn.addEventListener('click', () => {
            const base = getAppApiBase();
            if (!base) return;
            closePreviewMenu();
            setItemLoading(downloadBtn, true);
            // Trigger download via a hidden link
            window.location.href = `${base}/download`;
            setTimeout(() => setItemLoading(downloadBtn, false, 'fas fa-download'), 3000);
        });
    }

    // Reflect sync state on the GitHub button: if already synced, it opens the repo;
    // otherwise it exports. updateGithubBtn() is called on load + after a sync.
    function updateGithubBtn() {
        if (!exportGithubBtn) return;
        const label = exportGithubBtn.querySelector('span');
        if (config.githubRepoUrl) {
            exportGithubBtn.title = config.githubRepoUrl;
            exportGithubBtn.classList.add('synced');
            if (label) label.textContent = 'Open GitHub repo';
        } else {
            exportGithubBtn.title = 'Export to GitHub';
            exportGithubBtn.classList.remove('synced');
            if (label) label.textContent = 'Export to GitHub';
        }
    }
    updateGithubBtn();

    if (exportGithubBtn) {
        exportGithubBtn.addEventListener('click', async (event) => {
            const base = getAppApiBase();
            if (!base) return;

            // Already synced → just open the repo (don't re-export). Alt/Shift-click to re-export.
            if (config.githubRepoUrl && !(event && (event.altKey || event.shiftKey))) {
                closePreviewMenu();
                window.open(config.githubRepoUrl, '_blank');
                return;
            }

            const repoName = prompt('GitHub repository name (leave empty for auto):', '');
            if (repoName === null) return; // Cancelled

            closePreviewMenu();
            setItemLoading(exportGithubBtn, true);

            try {
                const resp = await fetch(`${base}/export-github`, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        repo_name: repoName || undefined,
                        is_private: true,
                    }),
                });
                const data = await resp.json();
                if (data.error) {
                    alert('Export failed: ' + data.error);
                } else {
                    config.githubRepoUrl = data.repo_url;  // remember so future clicks just open it
                    updateGithubBtn();
                    const openRepo = confirm(`Code exported to GitHub!\n\n${data.repo_url}\n\nOpen in browser?`);
                    if (openRepo) window.open(data.repo_url, '_blank');
                }
            } catch (err) {
                alert('Export failed: ' + err.message);
            } finally {
                setItemLoading(exportGithubBtn, false, 'fab fa-github');
            }
        });
    }

    if (deleteAppBtn) {
        deleteAppBtn.addEventListener('click', async () => {
            const base = getAppApiBase();
            if (!base) return;

            if (!confirm('Delete this app? This will stop the workspace VM and remove all data. This cannot be undone.')) return;

            closePreviewMenu();
            setItemLoading(deleteAppBtn, true);

            try {
                const resp = await fetch(base, {
                    method: 'DELETE',
                    credentials: 'same-origin',
                });
                const data = await resp.json();
                if (data.error) {
                    alert('Delete failed: ' + data.error);
                    setItemLoading(deleteAppBtn, false, 'fas fa-trash-alt');
                } else {
                    // Redirect to instant mode home
                    const homeUrl = (standaloneMode || !projectId) ? '/instant/' : `/instant/project/${projectId}/`;
                    window.location.href = homeUrl;
                }
            } catch (err) {
                alert('Delete failed: ' + err.message);
                setItemLoading(deleteAppBtn, false, 'fas fa-trash-alt');
            }
        });
    }

    // ---- Snake Game (plays while building) ----
    const snakeCanvas = document.getElementById('snake-game');
    const snakeCtx = snakeCanvas ? snakeCanvas.getContext('2d') : null;
    const snakePauseBtn = document.getElementById('snake-pause');

    const CELL = 16;                       // px per grid cell
    const COLS = 20, ROWS = 20;            // 320x320 canvas
    const TICK_MS = 100;

    function initSnakeState() {
        const mid = Math.floor(ROWS / 2);
        return {
            snake: [{x: 5, y: mid}, {x: 4, y: mid}, {x: 3, y: mid}],
            dir: {x: 1, y: 0},
            nextDir: {x: 1, y: 0},
            food: spawnFood([{x: 5, y: mid}, {x: 4, y: mid}, {x: 3, y: mid}]),
            score: 0,
            autoMode: true,
            autoTimer: 0,
        };
    }

    function spawnFood(snake) {
        let pos;
        do {
            pos = {x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS)};
        } while (snake.some(s => s.x === pos.x && s.y === pos.y));
        return pos;
    }

    function autoDirection(s) {
        const head = s.snake[0];
        const food = s.food;
        const dir = s.dir;

        // Simple chase: prefer direction toward food, avoid self-collision
        const candidates = [
            {x: 0, y: -1}, {x: 0, y: 1}, {x: -1, y: 0}, {x: 1, y: 0}
        ].filter(d => !(d.x === -dir.x && d.y === -dir.y)); // no reverse

        // Check which moves are safe
        const safe = candidates.filter(d => {
            const nx = (head.x + d.x + COLS) % COLS;
            const ny = (head.y + d.y + ROWS) % ROWS;
            return !s.snake.some(seg => seg.x === nx && seg.y === ny);
        });

        if (safe.length === 0) return dir; // no safe move, keep going

        // Sort by distance to food
        safe.sort((a, b) => {
            const ax = (head.x + a.x + COLS) % COLS, ay = (head.y + a.y + ROWS) % ROWS;
            const bx = (head.x + b.x + COLS) % COLS, by = (head.y + b.y + ROWS) % ROWS;
            const da = Math.abs(ax - food.x) + Math.abs(ay - food.y);
            const db = Math.abs(bx - food.x) + Math.abs(by - food.y);
            return da - db;
        });

        return safe[0];
    }

    function tickSnake() {
        if (!snakeState) return;
        const s = snakeState;

        // Auto-pilot
        if (s.autoMode) {
            s.nextDir = autoDirection(s);
        }

        s.dir = s.nextDir;
        const head = s.snake[0];
        const nx = (head.x + s.dir.x + COLS) % COLS;
        const ny = (head.y + s.dir.y + ROWS) % ROWS;

        // Self-collision → restart
        if (s.snake.some(seg => seg.x === nx && seg.y === ny)) {
            snakeState = initSnakeState();
            return;
        }

        s.snake.unshift({x: nx, y: ny});

        if (nx === s.food.x && ny === s.food.y) {
            s.score++;
            s.food = spawnFood(s.snake);
        } else {
            s.snake.pop();
        }

        drawSnake();
    }

    function drawSnake() {
        if (!snakeCtx || !snakeState) return;
        const ctx = snakeCtx;
        const s = snakeState;

        ctx.clearRect(0, 0, snakeCanvas.width, snakeCanvas.height);

        // Background grid (subtle)
        ctx.strokeStyle = 'rgba(255,255,255,0.03)';
        ctx.lineWidth = 0.5;
        for (let x = 0; x <= COLS; x++) {
            ctx.beginPath(); ctx.moveTo(x * CELL, 0); ctx.lineTo(x * CELL, ROWS * CELL); ctx.stroke();
        }
        for (let y = 0; y <= ROWS; y++) {
            ctx.beginPath(); ctx.moveTo(0, y * CELL); ctx.lineTo(COLS * CELL, y * CELL); ctx.stroke();
        }

        // Food
        ctx.fillStyle = '#f59e0b';
        ctx.shadowColor = '#f59e0b';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(s.food.x * CELL + CELL / 2, s.food.y * CELL + CELL / 2, CELL / 2 - 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;

        // Snake body
        s.snake.forEach((seg, i) => {
            const alpha = 1 - (i / s.snake.length) * 0.6;
            if (i === 0) {
                ctx.fillStyle = '#bb86fc';
                ctx.shadowColor = '#bb86fc';
                ctx.shadowBlur = 6;
            } else {
                ctx.fillStyle = `rgba(187, 134, 252, ${alpha})`;
                ctx.shadowBlur = 0;
            }
            const sx = seg.x * CELL + 1, sy = seg.y * CELL + 1, sw = CELL - 2, r = 3;
            ctx.beginPath();
            ctx.moveTo(sx + r, sy);
            ctx.lineTo(sx + sw - r, sy); ctx.arcTo(sx + sw, sy, sx + sw, sy + r, r);
            ctx.lineTo(sx + sw, sy + sw - r); ctx.arcTo(sx + sw, sy + sw, sx + sw - r, sy + sw, r);
            ctx.lineTo(sx + r, sy + sw); ctx.arcTo(sx, sy + sw, sx, sy + sw - r, r);
            ctx.lineTo(sx, sy + r); ctx.arcTo(sx, sy, sx + r, sy, r);
            ctx.fill();
        });
        ctx.shadowBlur = 0;

        // Score
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.font = '10px monospace';
        ctx.fillText('Score: ' + s.score, 6, 14);

        // Auto/manual indicator
        ctx.fillStyle = 'rgba(255,255,255,0.2)';
        ctx.fillText(s.autoMode ? 'Auto' : 'You', COLS * CELL - 30, 14);
    }

    function startSnakeGame() {
        if (snakeInterval) return;
        if (!snakeCanvas) return;
        snakePaused = false;
        if (snakePauseBtn) snakePauseBtn.textContent = '⏸ Pause';
        snakeState = initSnakeState();
        drawSnake();
        snakeInterval = setInterval(tickSnake, TICK_MS);
    }

    function stopSnakeGame() {
        if (snakeInterval) {
            clearInterval(snakeInterval);
            snakeInterval = null;
        }
        snakeState = null;
        snakePaused = false;
    }

    function setSnakePaused(paused) {
        snakePaused = paused;
        if (snakePauseBtn) snakePauseBtn.textContent = paused ? '▶ Resume' : '⏸ Pause';
        if (paused) {
            if (snakeInterval) { clearInterval(snakeInterval); snakeInterval = null; }
        } else if (snakeState && !snakeInterval) {
            snakeInterval = setInterval(tickSnake, TICK_MS);
        }
    }

    if (snakePauseBtn) {
        snakePauseBtn.addEventListener('click', () => setSnakePaused(!snakePaused));
    }

    // Keyboard controls — ARROW KEYS ONLY, and ONLY when the game board is focused
    // (click the board to play). This keeps typing in the chat from driving the snake.
    document.addEventListener('keydown', (e) => {
        if (!snakeState || snakePaused) return;
        // Game must be the focused element — clicking the board (tabindex=0) focuses it,
        // clicking the chat/input moves focus away and disables these controls.
        if (!snakeCanvas || document.activeElement !== snakeCanvas) return;
        const keyMap = {
            ArrowUp: {x: 0, y: -1}, ArrowDown: {x: 0, y: 1},
            ArrowLeft: {x: -1, y: 0}, ArrowRight: {x: 1, y: 0},
        };
        const nd = keyMap[e.key];
        if (!nd) return;
        // Don't reverse
        if (nd.x === -snakeState.dir.x && nd.y === -snakeState.dir.y) return;
        snakeState.nextDir = nd;
        snakeState.autoMode = false;
        // Resume auto after 5 seconds of no input
        clearTimeout(snakeState.autoTimer);
        snakeState.autoTimer = setTimeout(() => { if (snakeState) snakeState.autoMode = true; }, 5000);
        e.preventDefault();
    });

    // ---- Deferred init: set preview state + load history ----
    // Placed at end so all DOM element declarations (previewActions, snakeInterval, etc.) are ready.
    if (config.previewUrl) {
        loadPreview(config.previewUrl);
        setStatus('running', 'Running');
    } else if (config.currentAppStatus === 'building') {
        setPreviewState('building', 'Building your app...');
        setStatus('building', 'Building');
    } else if (config.currentAppStatus === 'error') {
        setStatus('error', 'Error');
    }

    // Load conversation history for existing apps — start HTTP immediately, don't wait for WS
    console.log('[Instant] History load decision:', { conversationId, appId: config.currentAppId, historyLoaded });
    if (conversationId) {
        console.log('[Instant] Calling loadConversationHistoryHTTP...');
        loadConversationHistoryHTTP();
    } else if (config.currentAppId) {
        console.log('[Instant] No conversationId, clearing loading indicator');
        clearLoadingIndicator();
    }
});
