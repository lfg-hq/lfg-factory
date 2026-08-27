document.addEventListener('DOMContentLoaded', () => {
    // Initialize file streaming debug globals
    window.FILE_STREAM_DEBUG = true;
    window.FILE_STREAM_CHUNKS = [];
    window.FILE_STREAM_CONTENT = '';
    
    // Check if the artifacts panel is in the DOM
    const artifactsPanel = document.getElementById('artifacts-panel');
    if (artifactsPanel) {
    } else {
        console.error('❌ Artifacts panel NOT found in DOM! This will cause issues with notifications.');
    }
    
    // Check if the ArtifactsPanel API is available
    if (window.ArtifactsPanel && typeof window.ArtifactsPanel.toggle === 'function') {
    } else {
        // We'll check again after a delay to see if it's a timing issue
        setTimeout(() => {
            if (window.ArtifactsPanel && typeof window.ArtifactsPanel.toggle === 'function') {
                console.log('✅ ArtifactsPanel API is now available (after delay)');
            } else {
                console.error('❌ ArtifactsPanel API is still NOT available after delay. Check script loading order.');
            }
        }, 1000);
    }
    
    const chatForm = document.getElementById('chat-form');
    const chatInput = document.getElementById('chat-input');
    const chatMessages = document.getElementById('chat-messages');
    const messageContainer = document.querySelector('.message-container') || createMessageContainer();
    const conversationList = document.getElementById('conversation-list');
    const newChatBtn = document.getElementById('new-chat-btn');
    const backBtn = document.getElementById('back-btn');
    const sidebar = document.getElementById('sidebar');
    const appContainer = document.querySelector('.app-container');
    const sidebarOverlay = document.getElementById('sidebar-overlay');
    
    let currentConversationId = null;
    let currentProvider = 'openai';
    let currentProjectId = null;
    // Make currentProjectId and currentConversationId globally accessible for ArtifactsLoader
    window.currentProjectId = null;
    window.currentConversationId = null;
    let socket = null;
    let isSocketConnected = false;
    let messageQueue = [];
    let isStreaming = false; // Track whether we're currently streaming a response
    let currentStreamingEl = null; // The .message.assistant element for the CURRENT response
    let stopRequested = false; // Track if user has already requested to stop generation
    
    // Chunk reassembly tracking
    let chunkBuffers = {};  // Store partial chunks by sequence number
    let expectedSequence = 0;  // Track expected sequence number
    
    // Get or create the send button
    const sendBtn = document.getElementById('send-btn') || createSendButton();
    let stopBtn = null; // Will be created when needed

    // Button state machine to prevent race conditions
    const ButtonState = {
        SEND: 'send',
        STOP: 'stop',
        TRANSITIONING: 'transitioning'
    };
    let currentButtonState = ButtonState.SEND;
    let buttonTransitionTimeout = null;
    
    // Extract project ID from path if in format /chat/project/{id}/
    function extractProjectIdFromPath() {
        const pathParts = window.location.pathname.split('/').filter(part => part);
        if (pathParts.length >= 3 && pathParts[0] === 'chat' && pathParts[1] === 'project') {
            return pathParts[2];
        }
        return null;
    }
    
    // Read server-injected data from DOM data attributes (avoids Hono html escaping issues)
    const serverDataEl = document.getElementById('server-data');
    const CURRENT_USER_ID = serverDataEl?.dataset.userId || '';

    // Check for conversation ID: URL query param > URL path > data attribute
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('conversation_id')) {
        currentConversationId = urlParams.get('conversation_id');
    } else {
        // Extract from URL path: /chat/project/:projectId/conversation/:conversationId
        const pathSegments = window.location.pathname.split('/').filter(Boolean);
        const convIdx = pathSegments.indexOf('conversation');
        if (convIdx !== -1 && pathSegments[convIdx + 1]) {
            currentConversationId = pathSegments[convIdx + 1];
        } else if (serverDataEl?.dataset.conversationId) {
            currentConversationId = serverDataEl.dataset.conversationId;
        }
    }
    // Sync to global for ArtifactsLoader
    window.currentConversationId = currentConversationId;

    // Track whether messages have been loaded to prevent duplicate loading
    let conversationLoadedViaRest = false;

    // Extract project ID from path
    const pathProjectId = extractProjectIdFromPath();

    if (!pathProjectId && !window.__AGENT_MODE__) {
        throw new Error('No project ID found in path. Expected format: /chat/project/{id}/');
    }

    currentProjectId = pathProjectId || null;
    window.currentProjectId = currentProjectId;
    console.log('Extracted project ID from path:', currentProjectId);
    
    // Store requirements for later use
    let pendingRequirements = null;
    const requirements = urlParams.get('requirements');
    console.log('URL requirements parameter:', requirements);
    if (requirements) {
        pendingRequirements = decodeURIComponent(requirements);
        console.log('Decoded requirements:', pendingRequirements);
        // Set the requirements in the chat input immediately so user can see it
        if (chatInput) {
            chatInput.value = pendingRequirements;
            console.log('Set chat input value to:', chatInput.value);
        } else {
            console.error('Chat input element not found!');
            // Try again after a short delay
            setTimeout(() => {
                const delayedChatInput = document.getElementById('chat-input');
                if (delayedChatInput) {
                    delayedChatInput.value = pendingRequirements;
                    console.log('Set chat input value after delay to:', delayedChatInput.value);
                }
            }, 100);
        }
        
        // Remove requirements from URL to avoid resubmitting on refresh
        const url = new URL(window.location);
        url.searchParams.delete('requirements');
        window.history.replaceState({}, '', url);
    }
    
    // Also set up a global variable that can be accessed from console for debugging
    window.debugPendingRequirements = pendingRequirements;
    
    // Initialize WebSocket connection
    connectWebSocket();
    
    // Load agent settings and initialize turbo mode
    loadAgentSettings();

    function isInstantModeEnabled() {
        return document.getElementById('turbo-mode-toggle')?.checked || false;
    }

    function updateArtifactsForInstantMode(isInstantMode) {
        const appTab = document.getElementById('apps');

        if (appTab) {
            const restartBtn = appTab.querySelector('#app-restart-server-btn');
            const showConsoleBtn = appTab.querySelector('#show-console-btn');
            const consolePanel = appTab.querySelector('#console-panel');
            if (restartBtn) restartBtn.style.display = isInstantMode ? 'none' : '';
            if (showConsoleBtn) showConsoleBtn.style.display = isInstantMode ? 'none' : '';
            if (consolePanel && isInstantMode) consolePanel.style.display = 'none';
        }
    }

    // Test backend notification sending
    window.testBackendNotification = function() {
        if (socket && socket.readyState === WebSocket.OPEN) {
            console.log('%c SENDING TEST NOTIFICATION REQUEST ', 'background: #00ff00; color: #000; font-weight: bold; padding: 5px;');
            socket.send(JSON.stringify({
                type: 'test_notification'
            }));
            console.log('Test notification request sent. Check console for WebSocket messages...');
        } else {
            console.error('WebSocket not connected');
        }
    };

    // Test function for execute_command
    window.testExecuteCommand = function() {
        if (socket && socket.readyState === WebSocket.OPEN) {
            console.log('%c SENDING TEST EXECUTE_COMMAND REQUEST ', 'background: #ffa500; color: #000; font-weight: bold; padding: 5px;');
            socket.send(JSON.stringify({
                type: 'test_execute_command'
            }));
            console.log('Test execute_command request sent. Check console for WebSocket messages...');
        } else {
            console.error('WebSocket not connected');
        }
    };
    
    // Add manual animation trigger for testing
    // window.triggerToolAnimation = function(toolName = 'extract_features') {
    //     console.log('Manually triggering tool animation for:', toolName);
        
    //     // 1. Show tool execution indicator
    //     const indicator = window.showToolExecutionIndicator(toolName);
    //     console.log('Tool execution indicator created:', indicator);
        
    //     // 2. Show function call indicator
    //     const funcIndicator = showFunctionCallIndicator(toolName);
    //     console.log('Function call indicator created:', funcIndicator);
        
    //     // 3. Add separator
    //     const separator = document.createElement('div');
    //     separator.className = 'function-call-separator';
    //     separator.innerHTML = `<div class="separator-line"></div>
    //                           <div class="separator-text">Manually triggered: ${toolName}</div>
    //                           <div class="separator-line"></div>`;
    //     messageContainer.appendChild(separator);
        
    //     // 4. Show progress for supported functions
    //     if (['extract_features', 'extract_personas'].includes(toolName)) {
    //         handleToolProgress({
    //             tool_name: toolName,
    //             message: `Starting ${toolName.replace('_', ' ')}...`,
    //             progress_percentage: 0
    //         });
            
    //         // Simulate progress
    //         setTimeout(() => {
    //             handleToolProgress({
    //                 tool_name: toolName,
    //                 message: `Processing...`,
    //                 progress_percentage: 50
    //             });
    //         }, 1000);
            
    //         setTimeout(() => {
    //             handleToolProgress({
    //                 tool_name: toolName,
    //                 message: `Completing...`,
    //                 progress_percentage: 100
    //             });
    //         }, 2000);
    //     }
        
    //     return true;
    // };
    
    // Variables for @ mention functionality
    let mentionDropdown = null;
    let mentionStartIndex = -1;
    let selectedMentionIndex = 0;
    let mentionFiles = [];
    let mentionMode = 'file';   // 'file' | 'ticket' | 'menu'
    let mentionTickets = [];
    let mentionMenuItems = [];  // top-level @ menu (Files / Ticket / Preview)
    // The active item list for the current mode (keyboard nav + selection).
    function activeMentionList() {
        return mentionMode === 'ticket' ? mentionTickets
            : mentionMode === 'menu' ? mentionMenuItems
            : mentionFiles;
    }
    function selectActiveMention(item) {
        if (mentionMode === 'ticket') return selectMentionTicket(item);
        if (mentionMode === 'menu') return selectMentionMenu(item);
        return selectMentionFile(item);
    }

    // Auto-resize the text area based on content
    chatInput.addEventListener('input', function(e) {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
        
        // Check for @file mentions
        const cursorPosition = this.selectionStart;
        const textBeforeCursor = this.value.substring(0, cursorPosition);
        
        // @-mention detection. Order matters: complete triggers (@ticket/@file)
        // win over the bare-@ menu (whose partial could be a prefix of them).
        const atTicketMatch = textBeforeCursor.match(/@ticket(\S*)$/i);
        const atFileMatch = textBeforeCursor.match(/@file(\S*)$/i);
        // Bare @ or a short partial that's a prefix of a known source → menu.
        const atMenuMatch = textBeforeCursor.match(/(^|\s)@([a-z]{0,6})$/i);
        const menuPartialOk = atMenuMatch && ['file', 'ticket', 'preview'].some(function(s){ return s.indexOf((atMenuMatch[2] || '').toLowerCase()) === 0; });

        if (atTicketMatch) {
            mentionMode = 'ticket';
            mentionStartIndex = textBeforeCursor.length - atTicketMatch[0].length;
            showTicketDropdown(atTicketMatch[1]);
        } else if (atFileMatch) {
            mentionMode = 'file';
            mentionStartIndex = textBeforeCursor.length - atFileMatch[0].length;
            showMentionDropdown(atFileMatch[1]);
        } else if (menuPartialOk) {
            mentionMode = 'menu';
            mentionStartIndex = textBeforeCursor.length - ('@' + (atMenuMatch[2] || '')).length;
            showAtMenu((atMenuMatch[2] || '').toLowerCase());
        } else {
            hideMentionDropdown();
        }
    });
    
    // Handle Enter key press in the textarea
    chatInput.addEventListener('keydown', function(e) {
        // Handle navigation in mention dropdown
        if (mentionDropdown && mentionDropdown.style.display !== 'none') {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                selectedMentionIndex = Math.min(selectedMentionIndex + 1, activeMentionList().length - 1);
                updateMentionSelection();
                return;
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                selectedMentionIndex = Math.max(selectedMentionIndex - 1, 0);
                updateMentionSelection();
                return;
            } else if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                var _list = activeMentionList();
                if (_list.length > 0) {
                    selectActiveMention(_list[selectedMentionIndex]);
                }
                return;
            } else if (e.key === 'Escape') {
                e.preventDefault();
                hideMentionDropdown();
                return;
            }
        }
        
        // Check if Enter was pressed without Shift key (Shift+Enter allows for new lines)
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault(); // Prevent the default behavior (new line)
            const message = this.value.trim();
            if (message || window.attachedFile) {
                sendMessage(message);
                this.value = '';
                this.style.height = 'auto';
                
                // Clear file attachment if exists
                const fileAttachmentIndicator = document.querySelector('.input-file-attachment');
                if (fileAttachmentIndicator) {
                    fileAttachmentIndicator.remove();
                }
            }
        }
    });
    
    // Load conversation history on page load
    loadConversations();
    
    // If we have a conversation ID, load that conversation's messages
    if (currentConversationId) {
        console.log('[init] loading conversation:', currentConversationId);
        loadConversation(currentConversationId);
    }
    
    // New chat button click handler
    newChatBtn?.addEventListener('click', (e) => {
        e.preventDefault();  // Prevent <a href="#"> from firing

        // Reset conversation ID but keep project ID
        currentConversationId = null;
        window.currentConversationId = null;  // Sync to global
        conversationLoadedViaRest = false;

        // Project ID should always be available from path
        const pathProjectId = extractProjectIdFromPath();
        if (!pathProjectId) {
            console.error('No project ID found in path during new chat creation');
        }

        // Clear chat messages and show welcome message
        clearChatMessages();

        // Add welcome message
        const welcomeMessage = document.createElement('div');
        welcomeMessage.className = 'welcome-message';
        welcomeMessage.innerHTML = '<h2>LFG 🚀🚀</h2><p>Start a conversation with the AI assistant below.</p>';
        messageContainer.appendChild(welcomeMessage);

        // Close existing WebSocket so the server-side consumer resets self.conversation
        if (socket) {
            socket.close();
            socket = null;
        }

        // Reconnect WebSocket to ensure clean session (no conversation on server)
        connectWebSocket();

        // Update URL to remove conversation_id param
        const url = new URL(window.location);
        url.searchParams.delete('conversation_id');
        window.history.pushState({}, '', url);

        // Remove active class from all conversations in sidebar
        document.querySelectorAll('.conversation-item').forEach(item => {
            item.classList.remove('active');
        });

        // Focus on input for immediate typing
        chatInput.focus();

        console.log('New chat session started with project ID:', currentProjectId);
    });
    
    // Submit message when form is submitted
    chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const message = chatInput.value.trim();
        if (message || window.attachedFile) {
            sendMessage(message);
            chatInput.value = '';
            chatInput.style.height = 'auto';
            
            // Clear file attachment if exists
            const fileAttachmentIndicator = document.querySelector('.input-file-attachment');
            if (fileAttachmentIndicator) {
                fileAttachmentIndicator.remove();
            }
        }
    });

    // Set up provider selection
    const providerOptions = document.querySelectorAll('input[name="ai-provider"]');
    providerOptions.forEach(option => {
        option.addEventListener('change', function() {
            if (this.checked) {
                currentProvider = this.value;
                console.log(`Switched to ${currentProvider} provider`);
            }
        });
    });
    
    // Back button click handler
    if (backBtn) {
        backBtn.addEventListener('click', () => {
            window.location.href = '/projects/';
        });
    }
    
    // Function to synchronize streaming state with server
    function syncStreamingState() {
        if (socket && socket.readyState === WebSocket.OPEN) {
            // Request current streaming state from server
            const syncMessage = {
                type: 'sync_state',
                conversation_id: currentConversationId
            };
            socket.send(JSON.stringify(syncMessage));
            console.log('Sent sync state request');
        }
    }
    
    // Window event listeners for WebSocket
    window.addEventListener('beforeunload', () => {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.close();
        }
    });
    
    // File upload functionality
    const fileUploadBtn = document.getElementById('file-upload-btn');
    const fileUploadInput = document.getElementById('file-upload-input');
    
    if (fileUploadBtn && fileUploadInput) {
        fileUploadBtn.addEventListener('click', () => {
            fileUploadInput.click();
        });
        
        // ── Multi-file attachments (up to MAX_ATTACHMENTS) ──
        // window.attachedFiles is the source of truth (an array of entries, each with
        // its own chip + in-flight upload promise). window.attachedFile is kept as a
        // synced alias to attachedFiles[0] so the older single-file code paths (submit/
        // enter guards) keep working unchanged.
        window.MAX_ATTACHMENTS = window.MAX_ATTACHMENTS || 4;
        window.attachedFiles = window.attachedFiles || [];
        window.syncPrimaryAttachedFile = function () {
            window.attachedFile = window.attachedFiles[0] || null;
        };

        // The chips render in a flex row ABOVE the input box (position handled in CSS).
        function getAttachmentChipsContainer() {
            const inputWrapper = document.querySelector('.input-wrapper');
            let c = document.querySelector('.input-file-attachments');
            if (!c && inputWrapper) {
                c = document.createElement('div');
                c.className = 'input-file-attachments';
                inputWrapper.appendChild(c);
            }
            return c;
        }
        function removeAttachmentChipsContainerIfEmpty() {
            const c = document.querySelector('.input-file-attachments');
            if (c && !c.children.length) c.remove();
        }

        // Attach ONE file: render its chip, upload it, track it in window.attachedFiles.
        window.attachFileToComposer = function attachFileToComposer(file) {
            if (!file) return;
            if (window.attachedFiles.length >= window.MAX_ATTACHMENTS) {
                alert('You can attach up to ' + window.MAX_ATTACHMENTS + ' files.');
                return;
            }
            console.log('User selected file:', file.name, 'type:', file.type, 'size:', file.size);

            const container = getAttachmentChipsContainer();
            const chip = document.createElement('div');
            chip.className = 'input-file-attachment uploading';
            chip.innerHTML = '<i class="fas fa-sync fa-spin"></i><span>Uploading ' + file.name + '…</span>';
            if (container) container.appendChild(chip);

            const entry = { file: file, name: file.name, type: file.type, size: file.size, id: null, uploading: true, chip: chip };
            window.attachedFiles.push(entry);
            window.syncPrimaryAttachedFile();

            const removeEntry = () => {
                const i = window.attachedFiles.indexOf(entry);
                if (i >= 0) window.attachedFiles.splice(i, 1);
                chip.remove();
                window.syncPrimaryAttachedFile();
                removeAttachmentChipsContainerIfEmpty();
            };
            const renderChip = (stateCls, iconCls, label) => {
                chip.className = 'input-file-attachment ' + stateCls;
                chip.innerHTML = '<i class="' + iconCls + '"></i><span>' + label + '</span>' +
                    '<button type="button" class="remove-file-btn" title="Remove file"><i class="fas fa-times"></i></button>';
                const btn = chip.querySelector('.remove-file-btn');
                if (btn) btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); removeEntry(); });
            };

            const uploadFile = async () => {
                try {
                    let conversationId = currentConversationId;
                    if (!conversationId) {
                        const urlParams = new URLSearchParams(window.location.search);
                        if (urlParams.has('conversation_id')) {
                            conversationId = urlParams.get('conversation_id');
                            currentConversationId = conversationId;
                        }
                    }
                    // Create a conversation first if none exists yet.
                    if (!conversationId) {
                        const csrfToken = getCsrfToken();
                        const createResponse = await fetch('/api/conversations/', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrfToken, 'X-Requested-With': 'XMLHttpRequest' },
                            body: JSON.stringify({ project_id: currentProjectId || null })
                        });
                        if (!createResponse.ok) throw new Error('Failed to create conversation');
                        const conversationData = await createResponse.json();
                        conversationId = conversationData.id;
                        currentConversationId = conversationId;
                        const url = new URL(window.location);
                        url.searchParams.set('conversation_id', conversationId);
                        window.history.pushState({}, '', url);
                    }
                    const fileResponse = await uploadFileToServer(file, conversationId);
                    entry.id = fileResponse.id;
                    renderChip('uploaded', 'fas fa-check-circle', file.name);
                } catch (error) {
                    console.error('File upload error:', error);
                    renderChip('error', 'fas fa-exclamation-circle', 'Error: ' + file.name);
                }
            };

            entry.uploadPromise = uploadFile().finally(() => {
                entry.uploading = false;
                // Re-enable send once ALL uploads settle.
                if (!window.attachedFiles.some((f) => f.uploading)) {
                    const sendBtn = document.querySelector('.send-message-btn, .send-button, [type="submit"]');
                    if (sendBtn) sendBtn.disabled = false;
                }
            });

            // Disable send while any upload is in flight so a fast user can't fire before
            // the file lands.
            const sendBtnNow = document.querySelector('.send-message-btn, .send-button, [type="submit"]');
            if (sendBtnNow) sendBtnNow.disabled = true;
        };

        fileUploadInput.addEventListener('change', (e) => {
            const picked = Array.from(e.target.files || []);
            const slots = window.MAX_ATTACHMENTS - window.attachedFiles.length;
            if (slots <= 0) {
                alert('You can attach up to ' + window.MAX_ATTACHMENTS + ' files.');
                fileUploadInput.value = '';
                return;
            }
            picked.slice(0, slots).forEach((f) => window.attachFileToComposer(f));
            if (picked.length > slots) {
                alert('Only ' + slots + ' more file(s) could be added (max ' + window.MAX_ATTACHMENTS + ').');
            }
            // Clear the input so selecting the same file again still fires `change`.
            fileUploadInput.value = '';
            chatInput.focus();
        });

        // ── Drag & drop upload ──
        // Dropping a file anywhere in the chat area routes it through the SAME
        // flow as the paperclip: set it into the file input and fire `change`.
        const dropZone = document.querySelector('.chat-container') || document.getElementById('chat-messages');
        if (dropZone) {
            let dragDepth = 0;
            const showOverlay = (on) => {
                let ov = document.getElementById('chat-drop-overlay');
                if (on) {
                    if (!ov) {
                        ov = document.createElement('div');
                        ov.id = 'chat-drop-overlay';
                        ov.textContent = 'Drop file to upload';
                        ov.style.cssText = 'position:absolute;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:rgba(124,58,237,.10);border:2px dashed #7c3aed;border-radius:12px;color:#7c3aed;font-size:16px;font-weight:600;pointer-events:none;';
                        const host = getComputedStyle(dropZone).position === 'static' ? (dropZone.style.position = 'relative', dropZone) : dropZone;
                        host.appendChild(ov);
                    }
                } else if (ov) { ov.remove(); }
            };
            dropZone.addEventListener('dragenter', (e) => { e.preventDefault(); if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) { dragDepth++; showOverlay(true); } });
            dropZone.addEventListener('dragover', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
            dropZone.addEventListener('dragleave', (e) => { e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (dragDepth === 0) showOverlay(false); });
            dropZone.addEventListener('drop', (e) => {
                if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
                e.preventDefault();
                dragDepth = 0; showOverlay(false);
                // Route ALL dropped files through the same multi-attach flow (up to the max).
                try {
                    Array.from(e.dataTransfer.files).forEach((f) => window.attachFileToComposer && window.attachFileToComposer(f));
                } catch (err) {
                    console.error('drop upload failed:', err);
                }
            });
        }
    }

    // Audio recording functionality
    const recordAudioBtn = document.getElementById('record-audio-btn');
    let mediaRecorder = null;
    let audioChunks = [];
    let recordingStartTime = null;
    let recordingTimer = null;
    let recordingIndicator = null;
    
    if (recordAudioBtn) {
        recordAudioBtn.addEventListener('click', async () => {
            if (!mediaRecorder || mediaRecorder.state === 'inactive') {
                // Start recording
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({ 
                        audio: {
                            echoCancellation: false,
                            noiseSuppression: false,
                            autoGainControl: false
                        }
                    });
                    
                    console.log('🎙️ Got audio stream:', {
                        active: stream.active,
                        tracks: stream.getTracks().map(t => ({
                            kind: t.kind,
                            enabled: t.enabled,
                            muted: t.muted,
                            readyState: t.readyState
                        }))
                    });
                    
                    mediaRecorder = new MediaRecorder(stream);
                    audioChunks = [];
                    
                    // Create and show waveform indicator
                    recordingIndicator = createRecordingIndicator();
                    const messagesContainer = document.getElementById('chat-messages');
                    messagesContainer.appendChild(recordingIndicator);
                    messagesContainer.scrollTop = messagesContainer.scrollHeight;
                    
                    // Set up Web Speech API for live transcription
                    let recognition = null;
                    let finalTranscript = '';
                    let interimTranscript = '';
                    
                    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
                        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
                        recognition = new SpeechRecognition();
                        
                        recognition.continuous = true;
                        recognition.interimResults = true;
                        recognition.lang = 'en-US';
                        
                        recognition.onstart = () => {
                            console.log('Speech recognition started');
                        };
                        
                        recognition.onresult = (event) => {
                            interimTranscript = '';
                            
                            for (let i = event.resultIndex; i < event.results.length; i++) {
                                const transcript = event.results[i][0].transcript;
                                
                                if (event.results[i].isFinal) {
                                    finalTranscript += transcript + ' ';
                                } else {
                                    interimTranscript += transcript;
                                }
                            }
                            
                            // Update transcription display
                            if (recordingIndicator && recordingIndicator.transcriptionArea) {
                                const displayText = finalTranscript + '<span style="color: #94a3b8; font-style: italic;">' + interimTranscript + '</span>';
                                recordingIndicator.transcriptionArea.innerHTML = displayText || '<span style="color: #94a3b8; font-style: italic;">Listening...</span>';
                                
                                // Show send button if there's any transcribed text
                                if (finalTranscript.trim() || interimTranscript.trim()) {
                                    recordingIndicator.sendBtn.style.display = 'block';
                                }
                            }
                        };
                        
                        recognition.onerror = (event) => {
                            console.error('Speech recognition error:', event.error);
                            if (recordingIndicator && recordingIndicator.transcriptionArea) {
                                recordingIndicator.transcriptionArea.innerHTML = '<span style="color: #ef4444;">Error: ' + event.error + '</span>';
                            }
                        };
                        
                        recognition.onend = () => {
                            console.log('Speech recognition ended');
                        };
                        
                        // Start recognition
                        try {
                            recognition.start();
                        } catch (e) {
                            console.error('Failed to start speech recognition:', e);
                        }
                        
                        // Store recognition instance for cleanup
                        window.currentRecognition = recognition;
                    } else {
                        console.warn('Web Speech API not supported');
                        if (recordingIndicator && recordingIndicator.transcriptionArea) {
                            recordingIndicator.transcriptionArea.innerHTML = '<span style="color: #f59e0b;">Live transcription not supported in this browser</span>';
                        }
                    }
                    
                    // Set up audio analysis for voice-reactive waveform
                    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
                    console.log('AudioContext created, state:', audioContext.state);
                    
                    // Resume audio context if suspended (browser security)
                    if (audioContext.state === 'suspended') {
                        console.log('AudioContext suspended, resuming...');
                        await audioContext.resume();
                        console.log('AudioContext resumed, new state:', audioContext.state);
                    }
                    
                    const analyser = audioContext.createAnalyser();
                    const microphone = audioContext.createMediaStreamSource(stream);
                    
                    // Store analyser globally for debugging
                    window.debugAnalyser = analyser;
                    window.debugMicrophone = microphone;
                    
                    console.log('Audio analysis setup:', {
                        analyserCreated: !!analyser,
                        microphoneCreated: !!microphone,
                        frequencyBinCount: analyser.frequencyBinCount,
                        streamActive: stream.active,
                        audioTracks: stream.getAudioTracks().length
                    });
                    
                    analyser.smoothingTimeConstant = 0.8;
                    analyser.fftSize = 256; // Increase for better frequency resolution
                    analyser.minDecibels = -90;
                    analyser.maxDecibels = -10;
                    
                    // Connect microphone -> analyser
                    microphone.connect(analyser);
                    
                    // Test the audio by checking if we're getting data
                    setTimeout(() => {
                        const testArray = new Uint8Array(analyser.frequencyBinCount);
                        analyser.getByteFrequencyData(testArray);
                        const testSum = testArray.reduce((a, b) => a + b, 0);
                        console.log('🔊 Audio routing test:', {
                            sum: testSum,
                            avg: testSum / testArray.length,
                            contextState: audioContext.state,
                            analyserConnected: true
                        });
                    }, 100);
                    
                    console.log('Audio routing established:', {
                        microphoneConnected: true,
                        analyserFftSize: analyser.fftSize,
                        frequencyBinCount: analyser.frequencyBinCount
                    });
                    
                    // Store audio context for cleanup
                    window.currentAudioContext = audioContext;
                    
                    // Simple waveform animation
                    let frameCount = 0;
                    let animationRunning = false;
                    
                    function animateWaveform() {
                        // Debug first frame
                        if (!animationRunning) {
                            console.log('🚀 First animation frame:', {
                                hasIndicator: !!recordingIndicator,
                                hasRecorder: !!mediaRecorder,
                                recorderState: mediaRecorder?.state,
                                hasAnalyser: !!analyser,
                                analyserBinCount: analyser?.frequencyBinCount
                            });
                            animationRunning = true;
                        }
                        
                        if (!recordingIndicator || !mediaRecorder || mediaRecorder.state !== 'recording') {
                            animationRunning = false;
                            return;
                        }
                        
                        try {
                            const dataArray = new Uint8Array(analyser.frequencyBinCount);
                            analyser.getByteFrequencyData(dataArray);
                            
                            // Get average volume
                            let sum = 0;
                            let max = 0;
                            for (let i = 0; i < dataArray.length; i++) {
                                sum += dataArray[i];
                                max = Math.max(max, dataArray[i]);
                            }
                            const average = sum / dataArray.length;
                            
                            // Log every 30 frames (0.5 second)
                            if (frameCount % 30 === 0) {
                                console.log('🎤 Audio:', {
                                    avg: average.toFixed(1),
                                    max: max,
                                    frame: frameCount,
                                    firstValues: dataArray.slice(0, 5).join(',')
                                });
                            }
                            frameCount++;
                            
                            // Update bars
                            const bars = recordingIndicator.querySelectorAll('.waveform-bar');
                            if (bars.length === 0) {
                                console.error('❌ No waveform bars found!');
                                return;
                            }
                            
                            bars.forEach((bar, i) => {
                                const index = Math.floor((i / bars.length) * dataArray.length);
                                const value = dataArray[index] || 0;
                                const height = 3 + (value / 255) * 30;
                                bar.style.height = height + 'px';
                            });
                            
                            requestAnimationFrame(animateWaveform);
                        } catch (error) {
                            console.error('❌ Animation error:', error);
                            animationRunning = false;
                        }
                    }
                    
                    // Start the animation loop
                    
                    // Add test function to window for debugging
                    window.testAudioLevel = () => {
                        const testData = new Uint8Array(analyser.frequencyBinCount);
                        analyser.getByteFrequencyData(testData);
                        const sum = testData.reduce((a, b) => a + b, 0);
                        const avg = sum / testData.length;
                        console.log('Manual audio test:', {
                            average: avg,
                            max: Math.max(...testData),
                            analyserState: analyser.context.state,
                            dataLength: testData.length
                        });
                        return avg;
                    };
                    
                    mediaRecorder.ondataavailable = (event) => {
                        audioChunks.push(event.data);
                    };
                    
                    mediaRecorder.onstop = async () => {
                        // Stop all tracks
                        stream.getTracks().forEach(track => track.stop());
                        
                        // Clean up audio context
                        if (window.currentAudioContext) {
                            window.currentAudioContext.close();
                            window.currentAudioContext = null;
                        }
                        
                        // Stop speech recognition
                        if (window.currentRecognition) {
                            window.currentRecognition.stop();
                            window.currentRecognition = null;
                        }
                        
                        // Get final transcript before removing indicator
                        let transcriptToSend = '';
                        if (recordingIndicator && recordingIndicator.transcriptionArea) {
                            // Extract text content without HTML
                            const tempDiv = document.createElement('div');
                            tempDiv.innerHTML = recordingIndicator.transcriptionArea.innerHTML;
                            transcriptToSend = tempDiv.textContent || tempDiv.innerText || '';
                            transcriptToSend = transcriptToSend.replace('Listening...', '').trim();
                        }
                        
                        // Remove recording indicator
                        if (recordingIndicator) {
                            recordingIndicator.remove();
                            recordingIndicator = null;
                        }
                        
                        // Check if recording was cancelled
                        if (window.recordingCancelled) {
                            window.recordingCancelled = false;
                            console.log('Recording cancelled by user');
                        } else {
                            // Always create the audio blob for consistency
                            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                            const audioFile = new File([audioBlob], `recording_${Date.now()}.webm`, { type: 'audio/webm' });
                            
                            console.log('Audio recording completed:', audioFile.name, 'size:', audioFile.size);
                            
                            // Send audio message with transcript (if available)
                            await sendAudioMessage(audioFile, transcriptToSend);
                        }
                        
                        // Reset button state
                        recordAudioBtn.classList.remove('recording');
                        recordAudioBtn.innerHTML = '<i class="fas fa-microphone"></i>';
                        
                        // Clear timer
                        if (recordingTimer) {
                            clearInterval(recordingTimer);
                            recordingTimer = null;
                        }
                    };
                    
                    mediaRecorder.start();
                    recordingStartTime = Date.now();
                    
                    // Update button state
                    recordAudioBtn.classList.add('recording');
                    recordAudioBtn.innerHTML = '<i class="fas fa-stop"></i>';
                    
                    // Start the waveform animation after recorder is started
                    animateWaveform();
                    
                    // Update timer in waveform indicator
                    recordingTimer = setInterval(() => {
                        const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
                        const minutes = Math.floor(elapsed / 60).toString().padStart(2, '0');
                        const seconds = (elapsed % 60).toString().padStart(2, '0');
                        
                        if (recordingIndicator) {
                            const timeDisplay = recordingIndicator.querySelector('.recording-time');
                            if (timeDisplay) {
                                timeDisplay.textContent = `${minutes}:${seconds}`;
                            }
                        }
                        
                        // Auto-stop after 5 minutes
                        if (elapsed >= 300) {
                            mediaRecorder.stop();
                        }
                    }, 1000);
                    
                } catch (error) {
                    console.error('Error accessing microphone:', error);
                    alert('Unable to access microphone. Please check your permissions.');
                }
            } else {
                // Stop recording
                mediaRecorder.stop();
            }
        });
    }
    
    // Connection management variables
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 5;
    const reconnectDelay = 3000;
    let heartbeatInterval = null;
    let lastHeartbeatResponse = Date.now();
    let connectionMonitorInterval = null;
    
    // Function to connect WebSocket and receive messages
    function connectWebSocket() {
        // Check if already connected
        if (socket && socket.readyState === WebSocket.OPEN) {
            console.log('WebSocket already connected');
            return;
        }
        
        // Determine if we're on HTTPS or HTTP
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws/chat/`;

        console.log('Current Project ID:', currentProjectId);
        console.log('URL path:', window.location.pathname);
        console.log('URL params:', window.location.search);
        
        // Add conversation ID and project ID as query parameters if available
        let wsUrlWithParams = wsUrl;
        const urlParams = [];
        
        if (currentConversationId) {
            urlParams.push(`conversation_id=${currentConversationId}`);
        }
        
        if (currentProjectId) {
            urlParams.push(`project_id=${currentProjectId}`);
            console.log('Adding project_id to WebSocket URL:', currentProjectId);
        } else {
            console.warn('No project_id available for WebSocket connection!');
            // Try once more to get project ID from path as a fallback
            const pathProjectId = extractProjectIdFromPath();
            if (pathProjectId) {
                currentProjectId = pathProjectId;
                window.currentProjectId = currentProjectId;
                urlParams.push(`project_id=${currentProjectId}`);
                console.log('Found and added project_id from path:', currentProjectId);
            }
        }
        
        if (urlParams.length > 0) {
            wsUrlWithParams = `${wsUrl}?${urlParams.join('&')}`;
        }
        
        console.log('Connecting to WebSocket:', wsUrlWithParams);
        
        // Close existing socket if it exists
        if (socket) {
            socket.close();
        }
        
        socket = new WebSocket(wsUrlWithParams);
        
        socket.onopen = function(e) {
            console.log('WebSocket connection established');
            isSocketConnected = true;
            reconnectAttempts = 0;  // Reset reconnect attempts
            
            // Show connected status
            showConnectionStatus('connected');
            
            // Start heartbeat monitoring
            startHeartbeat();
            startConnectionMonitor();
            
            // Synchronize state with server
            syncStreamingState();
            
            // Check if we have pending requirements to send
            console.log('Checking pending requirements:', pendingRequirements);
            console.log('Current chat input value:', chatInput ? chatInput.value : 'chatInput not found');
            if (pendingRequirements) {
                setTimeout(() => {
                    console.log('About to send pending requirements:', pendingRequirements);
                    if (typeof sendMessage === 'function') {
                        sendMessage(pendingRequirements);
                        if (chatInput) {
                            chatInput.value = '';
                            chatInput.style.height = 'auto';
                        }
                        pendingRequirements = null; // Clear to avoid re-sending
                    } else {
                        console.error('sendMessage function not available!');
                    }
                }, 500);
            }
            
            // Send any queued messages
            while (messageQueue.length > 0) {
                const queuedMessage = messageQueue.shift();
                socket.send(JSON.stringify(queuedMessage));
            }
            
            // Load any saved draft
            loadDraftMessage();
        };
        
        socket.onmessage = function(event) {
            const data = JSON.parse(event.data);
            
            // Handle heartbeat
            if (data.type === 'heartbeat') {
                lastHeartbeatResponse = Date.now();
                // Send acknowledgment
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ type: 'heartbeat_ack' }));
                }
                return;
            }

            // Live dev-preview status + step log → Preview tab
            if (data.type === 'preview_status') {
                if (window.PreviewTab && window.PreviewTab.onStatus) window.PreviewTab.onStatus(data);
                return;
            }
            if (data.type === 'preview_log') {
                if (window.PreviewTab && window.PreviewTab.onLog) window.PreviewTab.onLog(data);
                return;
            }
            if (data.type === 'preview_steps') {
                if (window.PreviewTab && window.PreviewTab.onSteps) window.PreviewTab.onSteps(data);
                return;
            }
            if (data.type === 'preview_profile') {
                if (window.PreviewTab && window.PreviewTab.onProfile) window.PreviewTab.onProfile(data);
                return;
            }
            if (data.type === 'preview_services') {
                if (window.PreviewTab && window.PreviewTab.onServices) window.PreviewTab.onServices(data);
                return;
            }
            // "Chat with ticket" live updates (native left panel).
            if (data.type === 'ticket_log' || data.type === 'ticket_log_output' || data.type === 'ticket_status') {
                if (window.TicketAgentChat && window.TicketAgentChat.onWs) window.TicketAgentChat.onWs(data);
                // A build state change → refresh the Task List so its row indicator updates
                // live (spinner on/off), even when the ticket panel is closed.
                if (data.type === 'ticket_status' && window.ArtifactsLoader && window.ArtifactsLoader._checklistProjectId) {
                    try { window.ArtifactsLoader.loadChecklist(window.ArtifactsLoader._checklistProjectId); } catch (_) {}
                }
                return;
            }
            
            // Reduced logging — only log non-chunk message types
            if (data.type !== 'ai_chunk' && data.type !== 'heartbeat') {
                console.log('WS message:', data.type, data.notification_type || '');
            }
            
            // Special handling for notifications - Use the same improved detection logic
            const isNotification = data.is_notification === true || 
                                  data.is_notification === "true" || 
                                  (data.notification_type && data.notification_type !== "");
                                  
            const isEarlyNotification = isNotification && 
                                       (data.early_notification === true || 
                                        data.early_notification === "true");
            
            // Log only actual notifications, not every chunk
            if (isNotification) {
                console.log('Notification:', data.notification_type, isEarlyNotification ? '(early)' : '', data.function_name || '');
            }
            
            // Log message content for troubleshooting empty messages
            if (data.type === 'ai_chunk' && data.is_final) {
                console.log('Final AI chunk received - conversation saved');
            } else if (data.type === 'ai_chunk' && data.chunk === '') {
                console.log('Empty AI chunk received - this may be a typing indicator');
            } else if (data.type === 'message' && (!data.message || data.message.trim() === '')) {
                console.warn('Empty message content received in message event:', data);
            }
            
            switch (data.type) {
                case 'chat_history':
                    // Skip if conversation was already loaded via REST fetch
                    if (conversationLoadedViaRest) {
                        console.log('Skipping WS chat_history — already loaded via REST');
                        break;
                    }
                    // Handle chat history
                    clearChatMessages();
                    data.messages.forEach(msg => {
                        // Handle audio messages
                        if (msg.audio_file) {
                            // Create audio indicator for historical audio messages
                            const audioIndicator = document.createElement('div');
                            audioIndicator.className = 'message-audio';
                            audioIndicator.innerHTML = `
                                <div class="message-audio-container">
                                    <div class="message-audio-header">
                                        <i class="fas fa-microphone" style="font-size: 14px;"></i>
                                        Voice message
                                    </div>
                                    ${msg.audio_file.transcription ? `
                                        <div class="audio-transcription">
                                            ${msg.audio_file.transcription}
                                        </div>
                                    ` : ''}
                                </div>
                            `;
                            // For audio messages, don't pass content since transcription is in the indicator
                            addMessageToChat(msg.role, '', { audioIndicator: audioIndicator });
                        } else if (msg.content && msg.content.trim() !== '') {
                            // Regular text messages
                            addMessageToChat(msg.role, msg.content, null, null, msg.is_partial);
                        }
                    });
                    scrollToBottom(true); // Force scroll when loading history
                    break;

                case 'message':
                    // Scope guard: a complete message (e.g. a preview launch summary) is
                    // broadcast to ALL of the user's connections. Only render it if it
                    // belongs to THIS project/conversation — otherwise a preview summary
                    // for another project (e.g. Kitereach) leaked into the open chat.
                    if (data.project_id && currentProjectId && data.project_id !== currentProjectId) break;
                    if (data.conversation_id && currentConversationId && data.conversation_id !== currentConversationId) break;
                    // Handle complete message
                    addMessageToChat(data.sender, data.message);
                    scrollToBottom(true); // Force scroll for complete messages
                    break;
                    
                case 'ai_chunk':
                    // Handle AI response chunk for streaming
                    // Skip entirely empty chunks that aren't typing indicators or final messages
                    // BUT don't skip notifications!
                    if (data.chunk === '' && !data.is_final && getLastAssistantMessage() && !data.is_notification) {
                        console.log('Skipping empty non-final chunk...');
                        break;
                    }
                    
                    handleAIChunk(data);
                    break;
                
                case 'tool_progress':
                    // Handle tool progress updates
                    handleToolProgress(data);
                    break;
                
                case 'stop_confirmed':
                    // Handle confirmation that generation was stopped
                    console.log('Generation stopped by server');

                    // Clean up orchestrator streaming marker
                    const stoppedBubble = document.querySelector('.orchestrator-streaming');
                    if (stoppedBubble) stoppedBubble.classList.remove('orchestrator-streaming');

                    // Remove tool activity indicator
                    const stoppedToolInd = document.querySelector('.tool-activity-indicator');
                    if (stoppedToolInd) stoppedToolInd.remove();

                    // If the user has already processed the stop locally, don't do anything
                    if (!stopRequested) {
                        // Remove typing indicator if it exists
                        const typingIndicator = document.querySelector('.typing-indicator');
                        if (typingIndicator) {
                            typingIndicator.remove();
                        }

                        // Check if there's an assistant message, if not add one
                        const assistantMessage = getLastAssistantMessage();
                        if (!assistantMessage) {
                            // No message was created yet, so create one with the stopped message
                            addMessageToChat('system', '*Generation stopped by server*');
                        }

                        // Re-enable input and restore send button
                        chatInput.disabled = false;
                        hideStopButton();
                    }

                    // Reset the flag
                    stopRequested = false;
                    break;
                    
                case 'heartbeat':
                    // Handle heartbeat - acknowledge it
                    lastHeartbeatResponse = Date.now();
                    socket.send(JSON.stringify({ type: 'heartbeat_ack' }));
                    
                    // Check if this is a heartbeat during operation
                    if (data.during_operation) {
                        console.log('Heartbeat during operation received - connection is alive');
                    }
                    break;
                    
                case 'sync_state_response':
                    // Handle state synchronization response
                    console.log('Received sync state response:', data);
                    
                    if (data.is_streaming) {
                        // Server says it's streaming but client isn't aware
                        if (!isStreaming) {
                            console.log('Server is streaming but client was unaware - updating UI');
                            isStreaming = true;
                            chatInput.disabled = true;
                            showStopButton();
                        }
                    } else {
                        // Server says it's not streaming
                        if (isStreaming) {
                            console.log('Client thought it was streaming but server says no - resetting UI');
                            resetStreamingState();
                        }
                    }
                    break;
                    
                case 'error':
                    console.error('WebSocket error:', data.message);
                    
                    // Check if this is a token exhaustion error
                    if (data.message && (
                        data.message.includes('token limit') || 
                        data.message.includes('tokens. Please upgrade') ||
                        data.message.includes('reached your') ||
                        data.message.includes('token quota')
                    )) {
                        showTokenExhaustedPopup();
                    }
                    
                    // Display error message to user
                    const errorMsg = document.createElement('div');
                    errorMsg.className = 'error-message';
                    errorMsg.textContent = data.message;
                    messageContainer.appendChild(errorMsg);
                    scrollToBottom();

                    // In case of error, FULLY restore UI — otherwise the "Thinking…"
                    // indicator (and the streaming lock) stay stuck forever when the
                    // server aborts a hung generation. Remove every typing indicator and
                    // reset the streaming flag so the next message actually sends.
                    document.querySelectorAll('.typing-indicator').forEach(function(el){ el.remove(); });
                    isStreaming = false;
                    chatInput.disabled = false;
                    hideStopButton();
                    break;
                    
                case 'token_usage_updated':
                    // Update the daily token usage display
                    if (window.updateDailyTokens) {
                        window.updateDailyTokens();
                    }
                    break;

                case 'ticket_finished':
                    // Scope guard: ticket cards broadcast to ALL of the user's connections.
                    // Only render for the project whose chat is open — otherwise another
                    // project's "Ticket Failed" card leaked into this conversation.
                    if (data.publicProjectId && currentProjectId && data.publicProjectId !== currentProjectId) break;
                    // Individual ticket completed or failed
                    const ticketMsg = document.createElement('div');
                    const isFailure = data.status === 'failed';
                    ticketMsg.className = `system-message ticket-${isFailure ? 'failed' : 'complete'}`;
                    ticketMsg.innerHTML = isFailure
                        ? `<strong>⚠ Ticket Failed</strong><br>${data.message}`
                        : `<strong>✓ Ticket Complete</strong><br>${data.message}`;
                    messageContainer.appendChild(ticketMsg);
                    scrollToBottom();
                    break;

                case 'batch_complete':
                    // Scope guard (see ticket_finished) — don't leak another project's
                    // build-chain summary into this conversation.
                    if (data.publicProjectId && currentProjectId && data.publicProjectId !== currentProjectId) break;
                    // All tickets in a project have finished executing
                    const batchMsg = document.createElement('div');
                    const hasFails = data.status === 'partial';
                    batchMsg.className = `system-message batch-complete ${hasFails ? 'has-failures' : ''}`;
                    batchMsg.innerHTML = hasFails
                        ? `<strong>⚠ Build Chain Finished</strong><br>${data.message}`
                        : `<strong>✓ Build Complete</strong><br>${data.message}`;
                    messageContainer.appendChild(batchMsg);
                    scrollToBottom();
                    break;

                default:
                    // Forward unhandled message types to agent handler (if loaded)
                    if (typeof window.__handleAgentWsMessage__ === 'function') {
                        window.__handleAgentWsMessage__(data);
                    }
                    break;
            }
        };
        
        socket.onclose = function(event) {
            stopHeartbeat();
            stopConnectionMonitor();
            isSocketConnected = false;
            
            // If we were streaming when connection was lost, reset the UI state
            if (isStreaming) {
                console.log('Connection lost while streaming, resetting UI state');
                resetStreamingState();
            }
            
            if (event.wasClean) {
                console.log(`WebSocket connection closed cleanly, code=${event.code}, reason=${event.reason}`);
            } else {
                console.error('WebSocket connection died');
                
                // Save current input as draft
                if (chatInput.value.trim()) {
                    saveDraftMessage(chatInput.value);
                }
                
                // Show connection lost indicator
                showConnectionStatus('disconnected');
                
                // Attempt to reconnect with exponential backoff
                if (reconnectAttempts < maxReconnectAttempts) {
                    const delay = reconnectDelay * Math.pow(1.5, reconnectAttempts);
                    reconnectAttempts++;
                    
                    console.log(`Attempting to reconnect (attempt ${reconnectAttempts}/${maxReconnectAttempts}) in ${delay}ms...`);
                    showConnectionStatus('reconnecting', reconnectAttempts, maxReconnectAttempts);
                    
                    setTimeout(() => {
                        connectWebSocket();
                    }, delay);
                } else {
                    showConnectionStatus('failed');
                    console.error('Max reconnection attempts reached');
                }
            }
        };
        
        socket.onerror = function(error) {
            console.error('WebSocket error:', error);
            isSocketConnected = false;
        };
    }
    
    // Function to handle AI response chunks
    function handleAIChunk(data) {
        // Handle chunked messages first
        if (data.is_chunked) {
            console.log(`Received chunk ${data.chunk_sequence}/${data.total_chunks} for sequence ${data.sequence}`);
            
            // Initialize buffer for this sequence if needed
            if (!chunkBuffers[data.sequence]) {
                chunkBuffers[data.sequence] = {
                    chunks: {},
                    totalChunks: data.total_chunks,
                    receivedChunks: 0
                };
            }
            
            // Store the chunk
            chunkBuffers[data.sequence].chunks[data.chunk_sequence] = data.chunk;
            chunkBuffers[data.sequence].receivedChunks++;
            
            // Check if we have all chunks
            if (chunkBuffers[data.sequence].receivedChunks === data.total_chunks) {
                // Reassemble the message
                let fullContent = '';
                for (let i = 0; i < data.total_chunks; i++) {
                    fullContent += chunkBuffers[data.sequence].chunks[i] || '';
                }
                
                // Clean up the buffer
                delete chunkBuffers[data.sequence];
                
                // Process the reassembled message
                data.chunk = fullContent;
                data.is_chunked = false;
                console.log('Reassembled full message:', fullContent.length, 'characters');
            } else {
                // Still waiting for more chunks
                console.log(`Waiting for ${data.total_chunks - chunkBuffers[data.sequence].receivedChunks} more chunks`);
                return;
            }
        }
        
        // Handle sequence validation
        if (data.sequence !== undefined) {
            if (data.sequence < expectedSequence) {
                console.warn(`Received old sequence ${data.sequence}, expected ${expectedSequence}. Ignoring.`);
                return;
            } else if (data.sequence > expectedSequence) {
                console.warn(`Received future sequence ${data.sequence}, expected ${expectedSequence}. Messages may be out of order.`);
            }
            expectedSequence = data.sequence + 1;
        }
        
        const chunk = data.chunk;
        const isFinal = data.is_final;
        
        // Debug logging only for notifications (skip for regular text chunks to reduce noise)
        if (data.is_notification || data.notification_type) {
            console.log('handleAIChunk notification:', data.notification_type, data.function_name);
        }
        
        
        // Fix notification detection by checking for either boolean true, string "true", or existence of notification_type
        // This handles cases where is_notification is undefined but we still want to process regular chunks
        const isNotification = data.is_notification === true || 
                              data.is_notification === "true" || 
                              (data.notification_type && data.notification_type !== "");
                              
        // Check if this is an early notification
        const isEarlyNotification = isNotification && 
                                   (data.early_notification === true || 
                                    data.early_notification === "true");
        
        // Reduced debug logging — only log notifications
        if (isNotification) {
            console.log("Notification:", data.notification_type, isEarlyNotification ? "(early)" : "", data.function_name || "");
        }
        
        if (isFinal) {
            // Final chunk with metadata
            console.log('AI response complete');

            // If this is the first (and only) chunk with content, create a message bubble
            if (chunk && !currentStreamingEl) {
                const typingInd = document.querySelector('.typing-indicator');
                if (typingInd) typingInd.remove();
                addMessageToChat('assistant', chunk);
                currentStreamingEl = getLastAssistantMessage();
            }

            // Skip creating a message if it's empty (likely just the final signal after a stop)
            if (chunk === '' && document.querySelector('.message.system:last-child')) {
                console.log('Skipping empty final chunk after stopped generation');
            }
            
            // Update conversation ID and other metadata if provided
            if (data.conversation_id) {
                currentConversationId = data.conversation_id;
                window.currentConversationId = currentConversationId;  // Sync to global

                // Update URL with conversation ID
                const url = new URL(window.location);
                url.searchParams.set('conversation_id', currentConversationId);
                window.history.pushState({}, '', url);
            }
            
            if (data.provider) {
                currentProvider = data.provider;
            }
            
            if (data.project_id) {
                currentProjectId = data.project_id;
                window.currentProjectId = currentProjectId;
            }
            
            // Check if this is the final chunk
            if (data.is_final) {
                // Streaming is complete — do a final markdown render to
                // ensure any pending debounced content is fully parsed.
                const finalMsg = currentStreamingEl || getLastAssistantMessage();
                if (finalMsg) {
                    const contentEl = finalMsg.querySelector('.message-content');
                    if (contentEl) {
                        // Clear any pending debounce timer
                        if (contentEl._markdownTimer) {
                            clearTimeout(contentEl._markdownTimer);
                            contentEl._markdownTimer = null;
                        }
                        const raw = contentEl.getAttribute('data-raw-content') || '';
                        if (raw) {
                            contentEl.innerHTML = marked.parse(raw);
                            contentEl._plainTail = null;
                        }
                    }
                }

                isStreaming = false;
                window.__isAgentStreaming__ = false;
                currentStreamingEl = null;

                // Clean up orchestrator streaming marker
                const streamingBubble = document.querySelector('.orchestrator-streaming');
                if (streamingBubble) streamingBubble.classList.remove('orchestrator-streaming');

                // If a connector_connected event arrived mid-stream and got
                // queued (silent enable case), flush it now — the original
                // stream is done so the server-side guard won't drop the
                // resend, and the WS-only resubmit won't duplicate the user
                // bubble.
                if (window.__pendingResubmit__ && typeof window.__handleAgentWsMessage__ === 'function') {
                    const toolkit = window.__pendingResubmit__;
                    window.__pendingResubmit__ = null;
                    console.log('[chat] flushing queued resubmit for toolkit:', toolkit);
                    // Tiny delay so the server marks isStreaming=false before our resend arrives
                    setTimeout(function () {
                        window.__handleAgentWsMessage__({ type: 'connector_connected', toolkit: toolkit, agent_id: null });
                    }, 100);
                }

                // Remove typing indicator if still present
                const typingIndicator = document.querySelector('.typing-indicator');
                if (typingIndicator) {
                    typingIndicator.remove();
                }

                // Re-enable the input
                chatInput.disabled = false;
                chatInput.focus();

                // Restore send button
                hideStopButton();

                // Turn complete → clear the persistent working indicator.
                removeFunctionCallIndicator(false, true);

                // Reset the stop requested flag
                stopRequested = false;
            }
            
            // Reload the conversations list to include the new one
            if (data.conversation_id) {
                loadConversations();
            }
            
            // Only return if this is the final chunk
            if (data.is_final) {
                return;
            }
        }
        
        // Handle early notifications (show a function call indicator but don't open artifacts yet)
        if (isEarlyNotification && data.function_name) {
            // Remove typing indicator — the tool pill replaces it
            const typingInd = document.querySelector('.typing-indicator');
            if (typingInd) typingInd.remove();

            // Show/UPDATE the persistent tool indicator (no remove → no flicker).
            showFunctionCallIndicator(data.function_name, { investigation: data.investigation });

            // Also show the tool progress indicator for long-running extraction functions
            if (['extract_features', 'extract_personas'].includes(data.function_name)) {
                handleToolProgress({
                    tool_name: data.function_name,
                    message: `Starting ${data.function_name.replace('_', ' ')}...`,
                    progress_percentage: 0
                });
            }

            scrollToBottom();
            return;
        }
        
        // Handle orchestrator notifications
        if (data.notification_type && data.notification_type.startsWith('orchestrator_')) {
            handleOrchestratorNotification(data);
            return;
        }

        // Specific action of the current tool (args now known) → update the live indicator.
        if (data.notification_type === 'tool_detail') {
            // Ensure the indicator exists (in case the detail beats the early notification),
            // then set its second line.
            if (!messageContainer.querySelector('.function-call-indicator')) {
                showFunctionCallIndicator(data.function_name, { investigation: data.investigation, detail: data.detail });
            } else {
                // The pill already exists — only its second line changes. Rebuilding
                // it here is what replayed the enter animation on every tool call.
                setToolDetail(null, data.detail);
            }
            scrollToBottom();
            return;
        }

        // Handle regular (completion) notifications
        if (isNotification && !isEarlyNotification) {
            console.log('Completion notification:', data.notification_type);
            
            // Check if this is ANY notification with file_id (for debugging)
            if (data.file_id) {
                console.log('==================================================');
                console.log('==================================================');
            }
            
            // Handle ask_user notification — render inline card with checkboxes
            if (data.notification_type === 'ask_user') {
                console.log('ask_user raw payload:', JSON.stringify(data).slice(0, 800));

                // Waiting on the user — the assistant genuinely stopped working.
                removeFunctionCallIndicator(false, true);

                // Normalize: support both new questions[] format and legacy single-question format
                let sections;
                if (data.questions && Array.isArray(data.questions) && data.questions.length > 0) {
                    sections = data.questions;
                } else if (data.questions && !Array.isArray(data.questions)) {
                    sections = [data.questions];
                } else if (data.suggestions && Array.isArray(data.suggestions) && data.suggestions.length > 0) {
                    // Legacy format: question + suggestions at top level
                    sections = [{
                        question: data.question || 'Choose an option',
                        suggestions: data.suggestions,
                        context: data.context || '',
                    }];
                } else {
                    // Empty questions — nothing to render, skip
                    console.warn('ask_user notification has no questions/suggestions, skipping');
                    return;
                }

                const totalSections = sections.length;
                let currentIdx = 0;

                // Per-section selections: array of { selected: Set, customText: string }
                const sectionState = sections.map(function() {
                    return { selected: new Set(), customText: '' };
                });

                // Build the card
                const card = document.createElement('div');
                card.className = 'ask-user-card';

                // Build each section
                const sectionEls = [];
                sections.forEach(function(sec, sIdx) {
                    const sectionDiv = document.createElement('div');
                    sectionDiv.className = 'ask-user-section' + (sIdx === 0 ? ' active' : '');

                    // Section header
                    const hdr = document.createElement('div');
                    hdr.className = 'ask-user-section-header';
                    const h4 = document.createElement('h4');
                    h4.textContent = sec.question;
                    hdr.appendChild(h4);
                    if (totalSections > 1) {
                        const badge = document.createElement('span');
                        badge.className = 'ask-user-section-badge';
                        badge.textContent = (sIdx + 1) + ' / ' + totalSections;
                        hdr.appendChild(badge);
                    }
                    sectionDiv.appendChild(hdr);

                    // Context
                    if (sec.context) {
                        const ctx = document.createElement('div');
                        ctx.className = 'ask-user-section-context';
                        ctx.textContent = sec.context;
                        sectionDiv.appendChild(ctx);
                    }

                    // Options list
                    const list = document.createElement('ul');
                    list.className = 'ask-user-options-list';

                    const customInput = document.createElement('input');
                    customInput.type = 'text';
                    customInput.className = 'ask-user-custom-input';
                    customInput.placeholder = 'Type your answer...';
                    customInput.style.display = 'none';
                    customInput.addEventListener('input', function() {
                        sectionState[sIdx].customText = customInput.value;
                    });

                    const allOpts = sec.suggestions.concat(['Something else']);

                    allOpts.forEach(function(opt, oIdx) {
                        const isSomethingElse = oIdx === allOpts.length - 1;
                        const row = document.createElement('li');
                        row.className = 'ask-user-option-row';

                        const checkbox = document.createElement('span');
                        checkbox.className = 'ask-user-option-checkbox';

                        const label = document.createElement('span');
                        label.className = 'ask-user-option-label';
                        label.textContent = opt;

                        row.appendChild(checkbox);
                        row.appendChild(label);
                        list.appendChild(row);

                        if (isSomethingElse) list.appendChild(customInput);

                        row.addEventListener('click', function() {
                            const state = sectionState[sIdx];
                            const isChecked = row.classList.toggle('checked');
                            checkbox.textContent = isChecked ? '✓' : '';

                            if (isChecked) {
                                state.selected.add(opt);
                            } else {
                                state.selected.delete(opt);
                            }

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
                const footer = document.createElement('div');
                footer.className = 'ask-user-footer';
                const countSpan = document.createElement('span');
                countSpan.className = 'ask-user-count';
                const footerBtns = document.createElement('div');
                footerBtns.className = 'ask-user-footer-buttons';
                const skipBtn = document.createElement('button');
                skipBtn.className = 'ask-user-skip-btn';
                skipBtn.textContent = 'Skip';
                const nextBtn = document.createElement('button');
                nextBtn.className = 'ask-user-next-btn';
                nextBtn.textContent = 'Next';
                const submitBtn = document.createElement('button');
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
                    sectionEls.forEach(function(el, i) {
                        el.classList.toggle('active', i === idx);
                    });
                    updateFooter();
                }

                function updateFooter() {
                    if (!sectionState[currentIdx]) return;
                    const n = sectionState[currentIdx].selected.size;
                    countSpan.textContent = n + ' selected';

                    const isLast = currentIdx === totalSections - 1;
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
                    chatInput.value = message;
                    chatForm.dispatchEvent(new Event('submit'));
                }

                nextBtn.addEventListener('click', function() {
                    if (currentIdx < totalSections - 1) showSection(currentIdx + 1);
                    scrollToBottom();
                });

                submitBtn.addEventListener('click', function() {
                    // Collect answers from all sections
                    const parts = [];
                    sectionState.forEach(function(state, sIdx) {
                        const choices = [];
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
                                const answerText = choices.length === 1
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

                // Add card into message container (where all messages live)
                messageContainer.appendChild(card);
                scrollToBottom();
                return;
            }

            // Handle confirm_action notification — blocking Yes/No permission popup
            if (data.notification_type === 'confirm_action') {
                // Blocking Yes/No — work is paused until they answer.
                removeFunctionCallIndicator(false, true);

                const title = data.title || 'Proceed?';
                const summary = data.summary || '';
                const confirmLabel = data.confirmLabel || 'Yes, go ahead';
                const cancelLabel = data.cancelLabel || 'No, let me adjust';

                const card = document.createElement('div');
                card.className = 'confirm-action-card';

                const body = document.createElement('div');
                body.className = 'confirm-action-body';

                const h4 = document.createElement('h4');
                h4.className = 'confirm-action-title';
                h4.textContent = title;
                body.appendChild(h4);

                if (summary) {
                    const p = document.createElement('div');
                    p.className = 'confirm-action-summary';
                    p.textContent = summary;
                    body.appendChild(p);
                }
                card.appendChild(body);

                const footer = document.createElement('div');
                footer.className = 'confirm-action-footer';

                const noBtn = document.createElement('button');
                noBtn.className = 'confirm-action-no-btn';
                noBtn.textContent = cancelLabel;

                const yesBtn = document.createElement('button');
                yesBtn.className = 'confirm-action-yes-btn';
                yesBtn.textContent = confirmLabel;

                footer.appendChild(noBtn);
                footer.appendChild(yesBtn);
                card.appendChild(footer);

                let answered = false;
                function lockCard() {
                    answered = true;
                    card.classList.add('dismissed');
                }

                yesBtn.addEventListener('click', function() {
                    if (answered) return;
                    lockCard();
                    chatInput.value = 'Yes, go ahead.';
                    chatForm.dispatchEvent(new Event('submit'));
                });

                noBtn.addEventListener('click', function() {
                    if (answered) return;
                    lockCard();
                    // Don't auto-send — let the user say what to change.
                    if (chatInput) {
                        chatInput.focus();
                        chatInput.placeholder = 'What would you like to change?';
                    }
                });

                messageContainer.appendChild(card);
                scrollToBottom();
                return;
            }

            // Handle open_app notification
            if (data.notification_type === 'open_app' && data.app_url) {

                // Switch to apps tab
                if (window.loadTabData) {
                    window.loadTabData('apps');
                }

                // Get elements
                const appEmpty = document.getElementById('app-empty');
                const appLoading = document.getElementById('app-loading');
                const appFrameContainer = document.getElementById('app-frame-container');
                const appIframe = document.getElementById('app-iframe');
                const appUrlInput = document.getElementById('app-url-input');
                const appUrlPanel = document.getElementById('app-url-panel');

                if (appIframe && appFrameContainer) {
                    // Show loading
                    if (appEmpty) appEmpty.style.display = 'none';
                    if (appLoading) appLoading.style.display = 'block';
                    if (appFrameContainer) appFrameContainer.style.display = 'none';

                    // Set URL in input field
                    if (appUrlInput) {
                        appUrlInput.value = data.app_url;
                    }

                    // Show URL panel
                    if (appUrlPanel) {
                        appUrlPanel.style.display = 'block';
                    }

                    // Load URL in iframe
                    appIframe.onload = function() {
                        if (appLoading) appLoading.style.display = 'none';
                        if (appFrameContainer) appFrameContainer.style.display = 'flex';
                    };

                    appIframe.onerror = function(e) {
                        console.error('[Chat] Error loading app iframe:', e);
                        if (appLoading) appLoading.style.display = 'none';
                        if (appEmpty) {
                            appEmpty.style.display = 'block';
                            appEmpty.innerHTML = `
                                <div class="empty-state-icon">
                                    <i class="fas fa-exclamation-triangle"></i>
                                </div>
                                <div class="empty-state-text">
                                    Error loading app. Please check if the server is running.
                                </div>
                            `;
                        }
                    };

                    appIframe.src = data.app_url;

                }

                return; // Don't process further
            }

            // ── Ticket streaming: switch to Task List tab and reload the proper ticket list ──
            if (data.notification_type === 'ticket_stream' && data.ticket) {
                // Open panel + switch to checklist tab
                if (window.ArtifactsPanel && typeof window.ArtifactsPanel.toggle === 'function') {
                    window.ArtifactsPanel.toggle(true);
                }
                document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
                const clBtn = document.querySelector('.tab-button[data-tab="checklist"]');
                const clPane = document.getElementById('checklist');
                if (clBtn) clBtn.classList.add('active');
                if (clPane) clPane.classList.add('active');

                // Reload the full ticket list UI so it matches what you see after refresh
                const pid = currentProjectId || window.extractProjectIdFromPath?.();
                if (pid && window.ArtifactsLoader && typeof window.ArtifactsLoader.loadChecklist === 'function') {
                    window.ArtifactsLoader.loadChecklist(pid);
                }
                return;
            }

            // Check if this is a document save notification with file_id
            // Handle any notification with a file_id as a potential document save, except for non-document types
            const nonDocumentTypes = ['features', 'personas', 'execute_command', 'command_output', 'start_server', 'checklist', 'open_app', 'ticket_stream']; // file_stream omitted: streaming chunks have no file_id, so the data.file_id guard already filters them; the is_complete notification needs to reach handleDocumentSaved
            if (data.file_id && !nonDocumentTypes.includes(data.notification_type)) {

                if (window.ArtifactsLoader && typeof window.ArtifactsLoader.handleDocumentSaved === 'function') {
                    window.ArtifactsLoader.handleDocumentSaved(data);
                    // Also refresh the file list so new file appears in the browser
                    const projectIdForRefresh = currentProjectId || extractProjectIdFromPath?.();
                    if (projectIdForRefresh && typeof window.ArtifactsLoader.loadFileBrowser === 'function') {
                        setTimeout(() => window.ArtifactsLoader.loadFileBrowser(projectIdForRefresh), 200);
                    }
                    return; // Don't process further
                } else {
                    console.error('[Chat] ArtifactsLoader.handleDocumentSaved not available!');
                    console.log('[Chat] handleDocumentSaved exists:', !!(window.ArtifactsLoader && window.ArtifactsLoader.handleDocumentSaved));
                }
            }

            // Show a function call indicator in the UI for the function that generated this notification
            const functionName = data.notification_type === 'features' ? 'extract_features' : 
                               data.notification_type === 'personas' ? 'extract_personas' : 
                               data.notification_type === 'execute_command' ? 'execute_command' : 
                               data.notification_type === 'command_output' ? 'execute_command' : 
                               data.notification_type === 'start_server' ? 'start_server' : 
                               data.notification_type === 'implementation' ? 'save_implementation' : 
                               data.notification_type === 'prd' ? 'create_prd' :
                               data.notification_type === 'file_stream' ? 'stream_file_content' :
                               data.notification_type === 'design' ? 'design_schema' :
                               data.notification_type === 'design_preview' ? 'generate_design_preview' :
                               data.notification_type === 'tickets' ? 'generate_tickets' :
                               data.notification_type === 'checklist' ? 'checklist_tickets' :
                               data.notification_type === 'ticket_stream' ? 'create_tickets' :
                               data.function_name || data.notification_type;

            // Dispatch event for design preview to refresh canvas
            if (data.notification_type === 'design_preview') {
                document.dispatchEvent(new CustomEvent('designPreviewGenerated', { detail: data }));
            }
            
            // Remove any previous function call indicators — but NOT during
            // file_stream content streaming (those are ongoing chunks, not completion)
            if (data.notification_type !== 'file_stream') {
                if (turnActive) {
                    // A tool finished but the turn hasn't. The model is now reasoning
                    // about what it just read, which can take 30s with nothing streaming.
                    // Keep the pill and say so, rather than leaving the last tool's
                    // stale action up — or, as before, blanking the screen entirely.
                    setToolDetail(null, 'Thinking…');
                } else {
                    removeFunctionCallIndicator();
                }

                // Remove tool execution indicator
                const toolExecutionIndicator = document.querySelector('.tool-execution-indicator');
                if (toolExecutionIndicator) {
                    toolExecutionIndicator.remove();
                }
            }
            
            
            // Check if we have a valid project ID from somewhere
            if (!currentProjectId) {
                // Only use extractProjectIdFromPath
                const pathProjectId = extractProjectIdFromPath();
                
                if (!pathProjectId) {
                    throw new Error('No project ID found in path. Expected format: /chat/project/{id}/');
                }
                
                console.log(`Using project ID from path: ${pathProjectId}`);
                currentProjectId = pathProjectId;
                window.currentProjectId = currentProjectId;
            }
            
            // If still no project ID, we can't proceed with loading artifacts
            if (!currentProjectId) {
                console.error('Unable to determine project ID for notification! Cannot load artifacts.');
                // Try to at least open the panel even if we can't load content
                if (window.ArtifactsPanel && typeof window.ArtifactsPanel.toggle === 'function') {
                    console.log('Opening artifacts panel with forceOpen=true');
                    try {
                        window.ArtifactsPanel.toggle(true); // Use forceOpen parameter to ensure it opens
                        console.log('ArtifactsPanel.toggle called successfully');
                        
                        // Double check if panel is actually open now
                        const panel = document.getElementById('artifacts-panel');
                        if (panel) {
                            console.log('Panel element found, expanded status:', panel.classList.contains('expanded'));
                            if (!panel.classList.contains('expanded')) {
                                console.log('Panel still not expanded after toggle, forcing expanded class');
                                panel.classList.add('expanded');
                                document.querySelector('.app-container')?.classList.add('artifacts-expanded');
                                document.getElementById('artifacts-button')?.classList.add('active');
                            }
                        } else {
                            console.error('Could not find artifacts-panel element in DOM');
                        }
                    } catch (err) {
                        console.error('Error toggling artifacts panel:', err);
                    }
                } else {
                    console.error('ArtifactsPanel not available!', window.ArtifactsPanel);
                }
                return;
            }
            
            console.log('\n\nArtifacts Panel Status:');
            console.log('ArtifactsPanel available:', !!window.ArtifactsPanel);
            console.log('Toggle function available:', !!(window.ArtifactsPanel && typeof window.ArtifactsPanel.toggle === 'function'));
            
            // Make sure artifacts panel is visible
            let panelOpenSuccess = false;
            
            // For file streaming, we should open the artifacts panel
            if (data.notification_type === 'file_stream') {
                console.log(`${data.notification_type} detected - checking if artifacts panel is open`);
                
                // Check if panel is already open
                const panel = document.getElementById('artifacts-panel');
                const isPanelOpen = panel && panel.classList.contains('expanded');
                
                if (!isPanelOpen) {
                    console.log('Panel is not open, opening it now');
                    // Try multiple methods to ensure panel opens
                    if (window.ArtifactsPanel && typeof window.ArtifactsPanel.toggle === 'function') {
                        console.log('Opening artifacts panel using ArtifactsPanel.toggle');
                        try {
                            window.ArtifactsPanel.toggle(true); // Force open
                            panelOpenSuccess = true;
                        } catch (err) {
                            console.error('Error opening artifacts panel for stream:', err);
                        }
                    }
                    
                    // Also try direct DOM manipulation as backup
                    if (!panelOpenSuccess) {
                        console.log('Trying direct DOM manipulation to open panel');
                        const appContainer = document.querySelector('.app-container');
                        const button = document.getElementById('artifacts-button');
                        
                        if (panel) {
                            panel.classList.add('expanded');
                            if (appContainer) appContainer.classList.add('artifacts-expanded');
                            if (button) button.classList.add('active');
                            panelOpenSuccess = true;
                            console.log('Panel opened via direct DOM manipulation');
                        }
                    }
                } else {
                    console.log('Panel is already open, skipping toggle to prevent reload');
                    panelOpenSuccess = true;
                }
            }

            // Update logic to pop open the artifacts panel when needed
            
            // if (window.ArtifactsPanel && typeof window.ArtifactsPanel.toggle === 'function') {
            //     console.log('Opening artifacts panel with ArtifactsPanel.toggle');
            //     try {
            //         window.ArtifactsPanel.toggle(true); // Use forceOpen parameter to ensure it opens
            //         console.log('ArtifactsPanel.toggle called successfully');
                    
            //         // Double check if panel is actually open now
            //         const panel = document.getElementById('artifacts-panel');
            //         if (panel) {
            //             console.log('Panel element found, expanded status:', panel.classList.contains('expanded'));
            //             panelOpenSuccess = panel.classList.contains('expanded');
                        
            //             if (!panelOpenSuccess) {
            //                 console.log('Panel still not expanded after toggle, adding expanded class directly');
            //                 panel.classList.add('expanded');
            //                 document.querySelector('.app-container')?.classList.add('artifacts-expanded');
            //                 document.getElementById('artifacts-button')?.classList.add('active');
            //                 panelOpenSuccess = true;
            //             }
            //         } else {
            //             console.error('Could not find artifacts-panel element in DOM');
            //         }
            //     } catch (err) {
            //         console.error('Error toggling artifacts panel:', err);
            //     }
            // } else {
            //     console.error('ArtifactsPanel not available!', window.ArtifactsPanel);
            // }
            
            // If the panel still isn't open, try the direct approach
            // if (!panelOpenSuccess && window.forceOpenArtifactsPanel) {
            //     console.log('Using forceOpenArtifactsPanel as fallback');
            //     window.forceOpenArtifactsPanel(data.notification_type);
            //     panelOpenSuccess = true;
            // }
            
            // Last resort - direct DOM manipulation if all else fails
            // if (!panelOpenSuccess) {
            //     console.log('Attempting direct DOM manipulation to open panel');
            //     try {
            //         // Try to manipulate DOM directly
            //         const panel = document.getElementById('artifacts-panel');
            //         const appContainer = document.querySelector('.app-container');
            //         const button = document.getElementById('artifacts-button');
                    
            //         if (panel && appContainer) {
            //             panel.classList.add('expanded');
            //             appContainer.classList.add('artifacts-expanded');
            //             if (button) button.classList.add('active');
            //             console.log('Panel forced open with direct DOM manipulation');
            //             panelOpenSuccess = true;
            //         }
            //     } catch (e) {
            //         console.error('Error in direct DOM manipulation:', e);
            //     }
            // }
            
            console.log('\n\nTab Switching Status:');
            console.log('switchTab available:', !!window.switchTab);
            console.log('notification_type available:', !!data.notification_type);
            
            // Switch to the appropriate tab
            if (window.switchTab && data.notification_type) {
                console.log(`Notification type: ${data.notification_type}`);

                // Only switch tabs for specific notification types (docs and tickets creation)
                const allowedTabSwitches = [
                    'prd',
                    'file_stream',
                    'file_saved',
                    'checklist',           // Mapped from create_tickets in backend
                    'create_tickets',      // In case it's not mapped
                    'create_checklist_tickets',
                    'tickets'
                ];

                // Skip tab switching for notification types not in the allowed list
                if (!allowedTabSwitches.includes(data.notification_type)) {
                    console.log(`Skipping tab switch for notification type: ${data.notification_type}`);
                } else {

                // Map notification types to actual tab names
                const tabMapping = {
                    'prd': 'filebrowser',  // Map prd to filebrowser tab
                    'file_stream': 'filebrowser',  // Map file_stream to filebrowser tab
                    'file_saved': 'filebrowser',   // Map file_saved to filebrowser tab
                    'tickets': 'checklist',
                    'checklist': 'checklist',      // Already the correct tab name
                    'create_checklist_tickets': 'checklist',
                    'create_tickets': 'checklist'  // Map create_tickets to checklist tab
                };

                // Use mapped tab if original doesn't exist
                const targetTab = tabMapping[data.notification_type] || data.notification_type;
                
                // Check if we're already on the target tab to avoid redundant switching during streaming
                const currentActiveTab = document.querySelector('.tab-button.active')?.getAttribute('data-tab');
                const isStreamingNotification = data.notification_type === 'file_stream';
                
                // Only switch tabs if we're not already on the target tab, or if it's not a streaming notification
                if (currentActiveTab !== targetTab || !isStreamingNotification) {
                    // Try the standard tab switching first
                    try {
                        window.switchTab(targetTab);
                        console.log(`Tab switched successfully to ${targetTab} using window.switchTab`);
                    } catch (err) {
                        console.error(`Error switching tab to ${targetTab} with window.switchTab:`, err);
                        
                        // Try direct DOM manipulation as fallback
                        try {
                            const tabButtons = document.querySelectorAll('.tab-button');
                            const tabPanes = document.querySelectorAll('.tab-pane');
                            
                            // Find the right tab using the mapped target
                            const targetButton = document.querySelector(`.tab-button[data-tab="${targetTab}"]`);
                            const targetPane = document.getElementById(targetTab);
                            
                            if (targetButton && targetPane) {
                                // Remove active class from all tabs
                                tabButtons.forEach(btn => btn.classList.remove('active'));
                                tabPanes.forEach(pane => pane.classList.remove('active'));
                                
                                // Set active class on the target tab
                                targetButton.classList.add('active');
                                targetPane.classList.add('active');
                                console.log(`Tab switched successfully to ${targetTab} using direct DOM manipulation`);
                            } else {
                                console.error(`Could not find tab elements for ${targetTab} (original: ${data.notification_type})`);
                            }
                        } catch (domErr) {
                            console.error('Error switching tab with direct DOM manipulation:', domErr);
                        }
                    }
                } else {
                    console.log(`Already on ${targetTab} tab during streaming, skipping tab switch`);
                }
                } // end of allowedTabSwitches else block

                // Load the content for that tab if we have a project ID
                // Load the appropriate content based on notification type
                if (window.ArtifactsLoader && currentProjectId) {
                    // Special handling for file streaming
                    if (data.notification_type === 'file_stream' && data.file_type === 'prd') {
                        if (data.content_chunk !== undefined) {
                            let projectIdForStreaming = currentProjectId || extractProjectIdFromPath();
                            if (!projectIdForStreaming) {
                                throw new Error('No project ID found in path. Expected format: /chat/project/{id}/');
                            }
                            if (projectIdForStreaming) {
                                window.ArtifactsLoader.streamDocumentContent(
                                    data.content_chunk, 
                                    data.is_complete || false, 
                                    projectIdForStreaming,
                                    'prd',
                                    data.prd_name || 'Main PRD',
                                );
                            } else {
                                console.error('PRD stream: No project ID available for streaming!');
                            }
                        } else {
                            console.error('PRD stream notification missing content_chunk!');
                        }
                    } else if (data.notification_type === 'file_stream' && data.file_type === 'implementation') {
                        if (data.content_chunk !== undefined) {
                            let projectIdForStreaming = currentProjectId || extractProjectIdFromPath();
                            if (!projectIdForStreaming) {
                                throw new Error('No project ID found in path. Expected format: /chat/project/{id}/');
                            }
                            if (projectIdForStreaming) {
                                window.ArtifactsLoader.streamDocumentContent(
                                    data.content_chunk,
                                    data.is_complete || false,
                                    projectIdForStreaming,
                                    'implementation',
                                    'Implementation Plan',
                                );
                            }
                        }
                    } else if (data.notification_type === 'file_stream' && data.file_type) {
                        // Generic handler for all other file types
                        if (data.content_chunk !== undefined) {
                            let projectIdForStreaming = currentProjectId || extractProjectIdFromPath();
                            if (!projectIdForStreaming) {
                                throw new Error('No project ID found in path. Expected format: /chat/project/{id}/');
                            }
                            if (projectIdForStreaming) {
                                window.ArtifactsLoader.streamDocumentContent(
                                    data.content_chunk,
                                    data.is_complete || false,
                                    projectIdForStreaming,
                                    data.file_type,
                                    data.file_name || `${data.file_type} Document`,
                                );
                            }
                        }
                    } else {
                        const loaderMap = {
                            'features': 'loadFeatures',
                            'personas': 'loadPersonas',
                            'prd': 'loadFileBrowser',
                            'implementation': 'loadFileBrowser',
                            'design': 'loadDesignSchema',
                            'tickets': 'loadTickets',
                            'checklist': 'loadChecklist'
                        };
                        
                        const loaderMethod = loaderMap[data.notification_type];
                        if (loaderMethod && typeof window.ArtifactsLoader[loaderMethod] === 'function') {
                            console.log(`Calling ArtifactsLoader.${loaderMethod}(${currentProjectId})`);
                            
                            // Normal loading for all notifications
                            // PRD and Implementation now use streaming and handle their own display
                            window.ArtifactsLoader[loaderMethod](currentProjectId);
                        } else if (data.notification_type === 'app_url') {
                            // Handle app_url notification - open app in artifacts panel
                            console.log(`Opening app in artifacts panel: ${data.app_url}`);
                            if (window.ArtifactsLoader && typeof window.ArtifactsLoader.openAppInArtifacts === 'function') {
                                window.ArtifactsLoader.openAppInArtifacts(data.app_url, data.workspace_id, data.port);
                            } else {
                                console.error('ArtifactsLoader.openAppInArtifacts not available!');
                            }
                        } else if (data.notification_type === 'command_output' ||
                                  data.notification_type === 'execute_command' ||
                                  data.notification_type === 'start_server' ||
                                  data.notification_type === 'implement_ticket') {
                            // These notification types don't have corresponding tabs/loaders
                            console.log(`Notification type '${data.notification_type}' doesn't require tab loading`);
                        } else {
                            console.log(`No loader method found for notification type: ${data.notification_type}`);
                        }
                    }
                }
            } else {
                console.error(`switchTab not available or no notification_type provided!`);
            }
            console.log('==========================================\n\n');
            return;
        }
        
        if (!chunk) {
            // This is just a typing indicator
            const typingIndicator = document.querySelector('.typing-indicator');
            if (!typingIndicator) {
                const indicator = document.createElement('div');
                indicator.className = 'typing-indicator';
                indicator.innerHTML =
                    '<span class="typing-indicator-label">Thinking</span>' +
                    '<span class="typing-indicator-dot"></span>' +
                    '<span class="typing-indicator-dot"></span>' +
                    '<span class="typing-indicator-dot"></span>';
                messageContainer.appendChild(indicator);
                scrollToBottom();
            }
            return;
        }
        
        // Check for function call mentions in text
        checkForFunctionCall(chunk);
        
        // Use the tracked streaming element for the current response.
        // If we don't have one yet, create a new assistant message.
        if (!currentStreamingEl) {
            // Remove typing indicator if present
            const typingIndicator = document.querySelector('.typing-indicator');
            if (typingIndicator) typingIndicator.remove();
            // Keep the "Gathering information" indicator up DURING the turn — agentic runs
            // interleave streamed text with tool calls, and removing it on each intermediate
            // message is what made it flicker on/off. Just move it BELOW the new message so it
            // stays pinned to the bottom; it's cleared on is_final / stop.
            const workingInd = messageContainer.querySelector('.function-call-indicator');
            addMessageToChat('assistant', chunk);
            if (workingInd) messageContainer.appendChild(workingInd);
            currentStreamingEl = getLastAssistantMessage();
        } else {
            // Accumulate raw content and render via marked
            const existingContent = currentStreamingEl.querySelector('.message-content');
            const raw = (existingContent.getAttribute('data-raw-content') || '') + chunk;
            existingContent.setAttribute('data-raw-content', raw);

            // Throttled markdown render — at most every 80ms
            if (!existingContent._markdownTimer) {
                existingContent._markdownTimer = setTimeout(() => {
                    existingContent._markdownTimer = null;
                    const latest = existingContent.getAttribute('data-raw-content') || '';
                    existingContent.innerHTML = marked.parse(latest);
                    scrollToBottom();
                }, 80);
            }
        }

        scrollToBottom();
    }
    
    // ------------------------------------------------------------------
    // Orchestrator UI
    // ------------------------------------------------------------------

    function handleOrchestratorNotification(data) {
        const subType = data.notification_type.replace('orchestrator_', '');

        // Always remove typing indicator when orchestrator content arrives
        const typingIndicator = document.querySelector('.typing-indicator');
        if (typingIndicator) {
            typingIndicator.remove();
        }

        switch (subType) {
            case 'text':
                // Normal text from orchestrator — render as assistant message
                // Remove tool activity indicator when text starts arriving
                const toolIndicator = document.querySelector('.tool-activity-indicator');
                if (toolIndicator) toolIndicator.remove();
                if (data.chunk) {
                    // Use a dedicated class to track the active streaming bubble
                    // so tool indicators or other elements don't break appending
                    let existing = document.querySelector('.orchestrator-streaming');
                    if (existing) {
                        const el = existing.querySelector('.message-content');
                        const raw = (el.getAttribute('data-raw-content') || '') + data.chunk;
                        el.setAttribute('data-raw-content', raw);
                        el.innerHTML = marked.parse(raw);
                        el._plainTail = null;
                    } else {
                        addMessageToChat('assistant', data.chunk);
                        // Mark the newly created bubble as the active streaming target
                        // Messages live inside .message-container, not #messages
                        const last = getLastAssistantMessage();
                        if (last) last.classList.add('orchestrator-streaming');
                    }
                    scrollToBottom();
                }
                break;

            case 'question':
                // Agent asking user a question — render inline in the chat flow
                {
                    const question = data.chunk || data.content || '';
                    const options = data.options || [];
                    const context = data.context || '';

                    // Build question text with bullet-formatted options
                    let questionText = '';
                    if (context) questionText += context + '\n\n';
                    questionText += question;
                    if (options.length > 0) {
                        questionText += '\n\n';
                        options.forEach(opt => {
                            questionText += `- ${opt}\n`;
                        });
                    }

                    // Find existing streaming bubble or create a new one
                    const streamingEl = document.querySelector('.orchestrator-streaming .message-content');
                    if (streamingEl) {
                        // Append to existing streamed message
                        const raw = (streamingEl.getAttribute('data-raw-content') || '') + '\n\n' + questionText;
                        streamingEl.setAttribute('data-raw-content', raw);
                        streamingEl.innerHTML = marked.parse(raw);
                    } else {
                        addMessageToChat('assistant', questionText);
                    }
                    scrollToBottom();
                }
                break;

            case 'status_update':
                // Pipeline status update
                renderPipelineStatus(data.payload || data.content || {});
                break;

            case 'tool_activity':
                // Show tool activity indicator (e.g., "Searching knowledge base...")
                showToolActivity(data.tool_label || data.tool_name || 'Working');
                break;


            default:
                // Fallback — treat as plain text
                if (data.chunk) {
                    addMessageToChat('assistant', data.chunk);
                    scrollToBottom();
                }
        }
    }

    /**
     * Show a tool activity indicator below the chat (replaces typing indicator).
     */
    function showToolActivity(label) {
        // Server-pushed tool activity joins the same trail — otherwise two different
        // progress widgets stack up on screen saying the same thing.
        const typing = document.querySelector('.typing-indicator');
        if (typing) typing.remove();
        const stale = document.querySelector('.tool-activity-indicator');
        if (stale) stale.remove();
        trailStep({ detail: label, icon: 'fa-bolt', color: '#a78bfa' });
    }

    /**
     * Render a question card inline in the chat.
     * The user can click an option or type a free-form answer.
     */
    function renderQuestionCard({ question, options, context, ticketExecutionId }) {
        const card = document.createElement('div');
        card.className = 'orchestrator-question-card';

        let html = '';
        if (context) {
            html += `<div class="oq-context">${context}</div>`;
        }
        html += `<div class="oq-question">${marked.parse(question)}</div>`;

        if (options && options.length > 0) {
            html += '<div class="oq-options">';
            options.forEach(opt => {
                html += `<button class="oq-option-btn" data-option="${opt.replace(/"/g, '&quot;')}">${opt}</button>`;
            });
            html += '</div>';
        }

        card.innerHTML = html;

        // Wire option buttons to send the answer
        card.querySelectorAll('.oq-option-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const answer = btn.getAttribute('data-option');
                // Put the answer in the chat input and send
                chatInput.value = answer;
                chatForm.dispatchEvent(new Event('submit'));
                // Disable the card after selection
                card.classList.add('oq-answered');
                card.querySelectorAll('.oq-option-btn').forEach(b => b.disabled = true);
                btn.classList.add('oq-selected');
            });
        });

        // Insert into chat
        const wrapper = document.createElement('div');
        wrapper.className = 'message assistant orchestrator-msg';
        wrapper.appendChild(card);
        messageContainer.appendChild(wrapper);
        scrollToBottom(true);
    }

    /**
     * Render or update the pipeline status card in the chat.
     */
    function renderPipelineStatus(status) {
        // Remove any existing pipeline card to update it
        const existing = document.querySelector('.orchestrator-pipeline-card');
        if (existing) existing.remove();

        const tickets = status.tickets || [];
        if (tickets.length === 0) return;

        const card = document.createElement('div');
        card.className = 'orchestrator-pipeline-card';

        const statusIcons = {
            queued: '<span class="op-icon op-queued"><i class="fas fa-clock"></i></span>',
            ready: '<span class="op-icon op-ready"><i class="fas fa-circle"></i></span>',
            running: '<span class="op-icon op-running"><i class="fas fa-spinner fa-spin"></i></span>',
            blocked: '<span class="op-icon op-blocked"><i class="fas fa-exclamation-triangle"></i></span>',
            completed: '<span class="op-icon op-completed"><i class="fas fa-check-circle"></i></span>',
            failed: '<span class="op-icon op-failed"><i class="fas fa-times-circle"></i></span>',
            cancelled: '<span class="op-icon op-cancelled"><i class="fas fa-ban"></i></span>',
            skipped: '<span class="op-icon op-skipped"><i class="fas fa-forward"></i></span>',
        };

        let html = '<div class="op-header">Pipeline Status</div>';
        html += `<div class="op-summary">${status.completed || 0}/${status.total_tickets || tickets.length} completed</div>`;
        html += '<div class="op-tickets">';
        tickets.forEach(t => {
            const icon = statusIcons[t.status] || statusIcons.queued;
            const blockedInfo = t.blocked_reason ? ` <span class="op-blocked-reason">${t.blocked_reason}</span>` : '';
            html += `<div class="op-ticket op-ticket-${t.status}">
                ${icon}
                <span class="op-title">${t.title}</span>
                ${blockedInfo}
            </div>`;
        });
        html += '</div>';

        card.innerHTML = html;

        const wrapper = document.createElement('div');
        wrapper.className = 'message assistant orchestrator-msg';
        wrapper.appendChild(card);
        messageContainer.appendChild(wrapper);
        scrollToBottom(true);
    }

    // Function to create message container if it doesn't exist
    function createMessageContainer() {
        const container = document.createElement('div');
        container.className = 'message-container';
        chatMessages.appendChild(container);
        return container;
    }
    
    // Function to create send button if it doesn't exist
    function createSendButton() {
        const btn = document.createElement('button');
        btn.id = 'send-btn';
        btn.type = 'submit';
        btn.className = 'action-btn';
        btn.innerHTML = '<i class="fas fa-paper-plane"></i>';
        btn.title = 'Send message';
        
        const inputActions = document.querySelector('.input-actions');
        if (inputActions) {
            inputActions.appendChild(btn);
        } else {
            chatForm.appendChild(btn);
        }
        return btn;
    }
    
    // Function to create and show stop button
    // The assistant is mid-turn. While this is true the working indicator is
    // PERSISTENT: individual tool notifications update its text but must not
    // remove it, otherwise the pill blinks out between every tool call.
    let turnActive = false;

    function showStopButton() {
        turnActive = true;
        // Check if we're already in the process of transitioning
        if (currentButtonState === ButtonState.TRANSITIONING) {
            console.log('Button transition in progress, skipping showStopButton');
            return;
        }
        
        // If already showing stop button, nothing to do
        if (currentButtonState === ButtonState.STOP) {
            console.log('Stop button already visible');
            return;
        }
        
        // Clear any pending transition
        if (buttonTransitionTimeout) {
            clearTimeout(buttonTransitionTimeout);
            buttonTransitionTimeout = null;
        }
        
        currentButtonState = ButtonState.TRANSITIONING;
        
        // Create stop button if it doesn't exist
        if (!stopBtn) {
            stopBtn = document.createElement('button');
            stopBtn.id = 'stop-btn';
            stopBtn.type = 'button';
            stopBtn.className = 'action-btn';
            stopBtn.innerHTML = '<i class="fas fa-stop"></i>';
            stopBtn.title = 'Stop generating';
            
            // Add event listener to stop button
            stopBtn.addEventListener('click', stopGeneration);
        }
        
        // Handle the input actions container
        const inputActions = document.querySelector('.input-actions');
        const sendBtnContainer = sendBtn.parentElement;
        
        if (inputActions && sendBtnContainer === inputActions) {
            // If send button is in input actions, replace it with stop button
            inputActions.replaceChild(stopBtn, sendBtn);
        } else {
            // Otherwise just append to form
            chatForm.appendChild(stopBtn);
            sendBtn.style.display = 'none';
        }
        
        isStreaming = true;
        window.__isAgentStreaming__ = true;
        currentButtonState = ButtonState.STOP;
        
        // Set a timeout to prevent stuck states
        buttonTransitionTimeout = setTimeout(() => {
            if (currentButtonState === ButtonState.STOP && !isStreaming) {
                console.log('Stuck in stop state, forcing reset');
                resetStreamingState();
            }
        }, 30000); // 30 seconds timeout
    }
    
    // Function to hide stop button and show send button
    function hideStopButton() {
        turnActive = false;
        // Check if we're already in the process of transitioning
        if (currentButtonState === ButtonState.TRANSITIONING) {
            console.log('Button transition in progress, skipping hideStopButton');
            return;
        }
        
        // If already showing send button, nothing to do
        if (currentButtonState === ButtonState.SEND) {
            console.log('Send button already visible');
            return;
        }
        
        // Clear any pending transition
        if (buttonTransitionTimeout) {
            clearTimeout(buttonTransitionTimeout);
            buttonTransitionTimeout = null;
        }
        
        currentButtonState = ButtonState.TRANSITIONING;
        
        const inputActions = document.querySelector('.input-actions');
        
        if (stopBtn) {
            if (inputActions && stopBtn.parentElement === inputActions) {
                // If stop button is in input actions, replace it with send button
                inputActions.replaceChild(sendBtn, stopBtn);
            } else {
                stopBtn.style.display = 'none';
                sendBtn.style.display = 'block';
            }
        }
        
        isStreaming = false;
        window.__isAgentStreaming__ = false;
        currentButtonState = ButtonState.SEND;
    }
    
    // Function to reset streaming state completely
    function resetStreamingState() {
        console.log('Resetting streaming state');

        // A dropped socket ends the turn as far as this tab is concerned — clear
        // the flag first so the working pill can actually be removed below,
        // instead of being stranded on screen forever.
        turnActive = false;
        removeFunctionCallIndicator(true, true);

        // Reset flags
        isStreaming = false;
        window.__isAgentStreaming__ = false;
        stopRequested = false;
        
        // Clear button transition timeout
        if (buttonTransitionTimeout) {
            clearTimeout(buttonTransitionTimeout);
            buttonTransitionTimeout = null;
        }
        
        // Force button state to SEND
        currentButtonState = ButtonState.SEND;
        
        // Remove typing indicator if exists
        const typingIndicator = document.querySelector('.typing-indicator');
        if (typingIndicator) {
            typingIndicator.remove();
        }
        
        // Force send button to be shown
        const inputActions = document.querySelector('.input-actions');
        if (stopBtn && inputActions && stopBtn.parentElement === inputActions) {
            // If stop button is in input actions, replace it with send button
            try {
                inputActions.replaceChild(sendBtn, stopBtn);
            } catch (e) {
                console.warn('Error replacing stop button:', e);
                // Fallback: ensure send button is visible
                if (!inputActions.contains(sendBtn)) {
                    inputActions.appendChild(sendBtn);
                }
            }
        } else if (stopBtn) {
            stopBtn.style.display = 'none';
            sendBtn.style.display = 'block';
        }
        
        // Re-enable chat input
        const chatInput = document.getElementById('chat-input');
        if (chatInput) {
            chatInput.disabled = false;
        }
        
        // Clear any active generation task reference
        if (window.activeStreamingTimeout) {
            clearTimeout(window.activeStreamingTimeout);
            window.activeStreamingTimeout = null;
        }
    }
    
    // Function to stop the generation
    function stopGeneration() {
        if (socket && socket.readyState === WebSocket.OPEN && !stopRequested) {
            // Set flag to indicate stop has been requested
            stopRequested = true;
            
            const stopMessage = {
                type: 'stop_generation',
                conversation_id: currentConversationId,
                project_id: currentProjectId
            };
            socket.send(JSON.stringify(stopMessage));
            console.log('Stop generation message sent');
            
            // Remove typing indicator if it exists
            const typingIndicator = document.querySelector('.typing-indicator');
            if (typingIndicator) {
                typingIndicator.remove();
            }
            // Clear the persistent working indicator on stop.
            removeFunctionCallIndicator(false, true);

            // Add a note that generation was stopped
            const assistantMessage = currentStreamingEl || getLastAssistantMessage();
            if (assistantMessage) {
                const contentDiv = assistantMessage.querySelector('.message-content');
                const currentContent = contentDiv.getAttribute('data-raw-content') || '';
                const newContent = currentContent + '\n\n*Generation stopped by user*';
                
                contentDiv.setAttribute('data-raw-content', newContent);
                contentDiv.innerHTML = marked.parse(newContent);
            } else {
                // If there's no assistant message yet, create one with the stopped message
                addMessageToChat('system', '*Generation stopped by user*');
            }
            
            // Reset UI - enable input and restore send button
            chatInput.disabled = false;
            hideStopButton();
        }
    }
    
    // Function to send message using WebSocket
    async function sendMessage(message) {
        console.log('sendMessage: Starting to send message:', message);

        // Check if we have a message or any attached file(s)
        if (!message && !(window.attachedFiles && window.attachedFiles.length)) {
            console.log('No message or file to send');
            return;
        }

        // Tagging @preview routes to the Preview agent — auto-open the Preview tab
        // so its live activity (commands/logs) is visible right away.
        if (typeof message === 'string' && /^\s*@preview\b/i.test(message) && typeof window.switchTab === 'function') {
            try { window.switchTab('preview'); } catch (_) {}
            // Open the live log overlay shortly after the tab mounts so the agent's
            // commands stream into view automatically.
            setTimeout(() => { try { window.PreviewTab && window.PreviewTab.showLogs && window.PreviewTab.showLogs(); } catch (_) {} }, 400);
        }

        // Snapshot the attached files up front (composer state is cleared below, so a
        // second click can't double-send). Each entry may still be uploading; we wait
        // for all of them so the WS payload carries every file's id.
        const attachments = (window.attachedFiles || []).slice();
        const buildFilesData = () => attachments.map((a) => {
            const fd = { name: a.name, type: a.type, size: a.size };
            if (a.id) fd.id = a.id;
            // Image → show it inline immediately (local object URL).
            if ((a.type || '').startsWith('image/') && a.file) fd.previewUrl = URL.createObjectURL(a.file);
            return fd;
        });

        // Optimistically render the user bubble RIGHT NOW (with ALL attachment chips) so
        // it doesn't vanish between click and upload-settle.
        let alreadyRenderedBubble = false;
        if (attachments.length) {
            addMessageToChat('user', message, buildFilesData());
            alreadyRenderedBubble = true;
        }

        // Wait for any uploads still in flight (otherwise the WS payload goes out before
        // we know each file's id and the LLM sees the message with no file context).
        const pendingUploads = attachments.filter((a) => a.uploading && a.uploadPromise);
        if (pendingUploads.length) {
            console.log('[sendMessage] waiting for ' + pendingUploads.length + ' upload(s) to finish before sending');
            try { await Promise.allSettled(pendingUploads.map((a) => a.uploadPromise)); } catch (_) {}
        }

        // Reset stop requested flag
        stopRequested = false;
        currentStreamingEl = null; // Reset for new response
        
        // Get selected role from dropdown if it exists
        let userRole = 'default';
        
        // First check the left menu submenu
        const roleSubmenu = document.getElementById('role-submenu');
        if (roleSubmenu) {
            const selectedRole = roleSubmenu.querySelector('.submenu-option.selected');
            if (selectedRole) {
                userRole = selectedRole.getAttribute('data-value') || 'default';
            }
        } else if (typeof getCustomDropdownValue === 'function' && document.getElementById('role-dropdown')) {
            userRole = getCustomDropdownValue('role-dropdown') || 'default';
        } else {
            // Fallback for old select dropdown
            const roleDropdown = document.getElementById('role-dropdown');
            if (roleDropdown && roleDropdown.tagName === 'SELECT') {
                userRole = roleDropdown.value;
            }
        }
        console.log('Selected role:', userRole);
        
        // Build the final files payload (ids now resolved after the wait) and clear the
        // composer's attachment state + chips.
        const filesData = buildFilesData();
        window.attachedFiles = [];
        if (window.syncPrimaryAttachedFile) window.syncPrimaryAttachedFile();
        const chipsContainer = document.querySelector('.input-file-attachments');
        if (chipsContainer) chipsContainer.remove();

        // Render the user bubble if we didn't already do it optimistically.
        if (!alreadyRenderedBubble) {
            addMessageToChat('user', message, filesData.length ? filesData : null, userRole);
        }

        // Send with all attachments (uploads that errored simply have no id; the backend
        // ignores those and describes/attaches the ones that uploaded).
        sendMessageToServer(message, filesData);
    }
    
    // Function to handle the actual WebSocket message sending
    function sendMessageToServer(message, filesData = null) {
        // Accept either an array of files (multi-attach) or a single object (legacy).
        const filesArr = Array.isArray(filesData) ? filesData.filter(Boolean) : (filesData ? [filesData] : []);
        const fileData = filesArr[0] || null; // primary — legacy single-file references below
        // Show typing indicator if not already present
        if (!document.querySelector('.typing-indicator')) {
            const typingIndicator = document.createElement('div');
            typingIndicator.className = 'typing-indicator';
            // Label + 3-dot pulse — pure dots were too subtle and users
            // assumed nothing was happening between send and first stream.
            typingIndicator.innerHTML =
                '<span class="typing-indicator-label">Thinking</span>' +
                '<span class="typing-indicator-dot"></span>' +
                '<span class="typing-indicator-dot"></span>' +
                '<span class="typing-indicator-dot"></span>';
            messageContainer.appendChild(typingIndicator);
            console.log('sendMessageToServer: Added typing indicator');
        }

        // Force scroll to bottom when user sends a message (they expect to see response)
        scrollToBottom(true);

        // Disable input while waiting for response (if not already disabled)
        chatInput.disabled = true;

        // Show stop button since we're about to start streaming
        showStopButton();
        
        // Get selected role from dropdown if it exists
        let userRole = 'default';
        const roleDropdown = document.getElementById('role-dropdown');
        if (roleDropdown) {
            userRole = roleDropdown.value;
            console.log('Selected role for API request:', userRole);
        }
        
        // Get turbo mode toggle state
        const turboModeToggle = document.getElementById('turbo-mode-toggle');
        const turboMode = turboModeToggle ? turboModeToggle.checked : false;
        
        // Agent-mode: when a file is attached, append a wire-only context
        // note so the LLM knows where the file lives in the sandbox. The user
        // bubble already shows the file chip (rendered from fileData) — this
        // note ONLY goes into the WS payload, not the on-screen text.
        // Catches BOTH upload paths (upload-on-attach and upload-on-send) by
        // hooking here right before the WS send instead of inside an upload
        // .then() that only the upload-on-send path takes.
        let outgoingMessage = message;
        if (window.__AGENT_MODE__ && filesArr.length) {
            const note = filesArr.length === 1
                ? `[Attached file: ${filesArr[0].name}` +
                  ` — available in the workspace at /root/data/${filesArr[0].name}` +
                  ` and downloadable from the Data Room.` +
                  ` Read it directly with pandas / openpyxl / etc.]`
                : `[Attached ${filesArr.length} files: ${filesArr.map((f) => f.name).join(', ')}` +
                  ` — each available in the workspace at /root/data/<name> and downloadable from the Data Room.` +
                  ` Read them directly with pandas / openpyxl / etc.]`;
            outgoingMessage = (message || "").trim() + (message ? "\n\n" : "") + note;
            console.log('[agent-mode] appended file-context note to WS payload for', filesArr.map((f) => f.name).join(', '));
        }

        // Prepare message data
        const messageData = {
            type: 'message',
            message: outgoingMessage,
            conversation_id: currentConversationId,
            provider: currentProvider,
            project_id: currentProjectId,
            user_role: userRole,
            turbo_mode: turboMode
        };
        
        // Add project_id if available
        if (currentProjectId) {
            messageData.project_id = currentProjectId;
        }
        
        // Add file data if provided. Send the full `files` array (backend prefers it) plus
        // the single `file` for backward compatibility.
        if (filesArr.length) {
            messageData.files = filesArr;
            messageData.file = fileData;
        }
        
        // Add mentioned files if any
        if (window.mentionedFiles && Object.keys(window.mentionedFiles).length > 0) {
            messageData.mentioned_files = window.mentionedFiles;
            // Clear mentioned files after adding to message
            window.mentionedFiles = {};
        }

        // Add mentioned tickets (@ticket:KEY) — the server injects each ticket's
        // context and switches the Preview to the first ticket's branch.
        if (window.mentionedTickets && Object.keys(window.mentionedTickets).length > 0) {
            messageData.mentioned_tickets = Object.values(window.mentionedTickets);
            window.mentionedTickets = {};
        }

        // Add current design canvas ID if available
        if (window.currentDesignCanvasId) {
            messageData.canvas_id = window.currentDesignCanvasId;
        }
        
        console.log('sendMessageToServer: Message data:', messageData);
        
        // Send via WebSocket if connected, otherwise queue
        if (isSocketConnected && socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(messageData));
        } else {
            console.log('WebSocket not connected, queueing message');
            messageQueue.push(messageData);

            // Try to reconnect
            if (!isSocketConnected) {
                connectWebSocket();
            }
        }
    }

    // Exposed for agents.js' silent auto-resend after a connector enables
    // mid-conversation. Bypasses addMessageToChat (don't render a new user
    // bubble — the original is already there) and bypasses the form path
    // (don't touch the input value). Pure WS send + typing indicator.
    // Send a VISIBLE chat message programmatically (renders the user bubble, does @preview
    // routing). Used by the preview panel's per-app "Fix" button.
    window.__sendChatMessage__ = function (message) {
        try { return sendMessage(message); } catch (_) {}
    };
    window.__sendChatMessageSilent__ = function (message) {
        if (!message || typeof message !== 'string') return;
        // Show typing indicator so the user knows something's happening
        if (!document.querySelector('.typing-indicator')) {
            const ti = document.createElement('div');
            ti.className = 'typing-indicator';
            ti.innerHTML =
                '<span class="typing-indicator-label">Thinking</span>' +
                '<span class="typing-indicator-dot"></span>' +
                '<span class="typing-indicator-dot"></span>' +
                '<span class="typing-indicator-dot"></span>';
            messageContainer.appendChild(ti);
            scrollToBottom(true);
        }
        showStopButton();
        chatInput.disabled = true;
        const payload = {
            type: 'message',
            message: message,
            conversation_id: currentConversationId,
            provider: currentProvider,
            project_id: currentProjectId,
        };
        if (isSocketConnected && socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(payload));
        } else {
            messageQueue.push(payload);
            if (!isSocketConnected) connectWebSocket();
        }
    };

    // Function to upload file to server via REST API
    async function uploadFileToServer(file, conversationId = null, messageId = null) {
        try {
            // Agent-mode short-circuit: the legacy /api/files/upload/ endpoint
            // (Django-era) doesn't exist in the Node app. For agents, route the
            // chat-input paperclip to the agent's Data Room upload endpoint so
            // the file is stored in S3 + visible in the Data Room tab.
            if (window.__AGENT_MODE__ && document.body.dataset.agentId) {
                const agentId = document.body.dataset.agentId;
                const uploadingToast = showFileNotification(`Uploading ${file.name} to Data Room...`, 'uploading');
                const dismissUploading = () => {
                    if (!uploadingToast) return;
                    uploadingToast.classList.remove('show');
                    setTimeout(() => uploadingToast.remove(), 300);
                };
                try {
                    const fd = new FormData();
                    fd.append('file', file);
                    const res = await fetch(`/api/agents/${agentId}/data`, {
                        method: 'POST',
                        body: fd,
                        credentials: 'same-origin',
                    });
                    if (!res.ok) {
                        const errText = await res.text().catch(() => '');
                        throw new Error(`Upload failed (${res.status}): ${errText.slice(0, 140)}`);
                    }
                    const data = await res.json();
                    const fileId = data.file?.id;
                    dismissUploading();
                    showFileNotification(`${file.name} uploaded to Data Room`, 'success');
                    return { id: fileId, file_name: data.file?.file_name ?? file.name };
                } catch (err) {
                    dismissUploading();
                    throw err;
                }
            }

            console.log('%c FILE UPLOAD - Starting file upload process', 'background: #3a9; color: white; font-weight: bold;');
            console.log('File to upload:', file);
            console.log('Conversation ID:', conversationId);
            console.log('Message ID:', messageId);

            // Validate that we have a conversation ID if required
            if (!conversationId) {
                console.warn('No conversation ID provided for file upload');
                showFileNotification(`File upload requires a conversation ID`, 'error');
                throw new Error('Conversation ID is required');
            }

            // Show uploading notification
            const notification = showFileNotification(`Uploading ${file.name}...`, 'uploading');

            const formData = new FormData();
            formData.append('file', file);
            formData.append('conversation_id', conversationId);
            if (messageId) {
                formData.append('message_id', messageId);
            }

            // Get CSRF token
            const csrfToken = getCsrfToken();
            console.log('CSRF Token obtained:', csrfToken ? 'Token exists' : 'No token found');

            // Log request details
            console.log('%c API REQUEST - About to send file upload request', 'background: #f50; color: white; font-weight: bold;');
            console.log('Endpoint:', '/api/files/upload/');
            console.log('Method:', 'POST');
            console.log('FormData contents:', {
                file: file.name,
                conversation_id: conversationId,
                message_id: messageId || 'Not provided'
            });

            // Add a timestamp to force cache busting
            const timestamp = new Date().getTime();
            const apiUrl = `/api/files/upload/?_=${timestamp}`;
            
            // Force this to be a visible network call by adding headers
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'X-CSRFToken': csrfToken,
                    'X-Requested-With': 'XMLHttpRequest',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0'
                },
                body: formData,
                credentials: 'same-origin' // Include cookies
            });
            
            console.log('%c API RESPONSE - Received response from server', 'background: #0a5; color: white; font-weight: bold;');
            console.log('Response status:', response.status);
            console.log('Response OK:', response.ok);
            
            // Read the body ONCE as text; then try to parse as JSON. Avoids
            // the "body stream already read" error when an error response
            // isn't valid JSON and the fallback tries to .text() after .json().
            const rawBody = await response.text();
            let parsed = null;
            try { parsed = rawBody ? JSON.parse(rawBody) : null; } catch { /* leave null */ }

            if (!response.ok) {
                console.error('Upload failed with status:', response.status, 'body:', rawBody.slice(0, 300));
                throw new Error(parsed?.error || `Failed to upload file: ${response.status}`);
            }

            if (!parsed) {
                console.error('Failed to parse JSON response. Raw body:', rawBody.slice(0, 300));
                throw new Error('Invalid response format from server');
            }
            const data = parsed;
            console.log('%c SUCCESS - File uploaded successfully', 'background: #0c0; color: white; font-weight: bold;');
            console.log('Server response:', data);
            
            // Check for file_id in response
            if (!data.id) {
                console.error('Server response missing file_id:', data);
                throw new Error('Server did not return a file_id');
            }
            
            console.log('%c FILE ID - Obtained file ID from server', 'background: #00c; color: white; font-weight: bold;');
            console.log('File ID:', data.id);
            
            // Update notification to show success
            if (notification && notification.parentNode) {
                notification.className = 'file-notification success';
                notification.innerHTML = `
                    <i class="fas fa-check-circle"></i>
                    <span>File ${file.name} uploaded successfully (ID: ${data.id})</span>
                `;
                
                // Remove after a delay
                setTimeout(() => {
                    if (notification.parentNode) {
                        notification.classList.remove('show');
                        setTimeout(() => notification.remove(), 300);
                    }
                }, 5000);
            }
            
            // Return the data with file_id
            return data;
        } catch (error) {
            console.error('%c ERROR - File upload failed', 'background: #f00; color: white; font-weight: bold;');
            console.error('Error details:', error);
            console.error('Stack trace:', error.stack);
            
            // Show error notification
            showFileNotification(`Error uploading file: ${error.message}`, 'error');
            throw error;
        }
    }
    
    // Helper function to show file notifications
    function showFileNotification(message, type = 'info') {
        // Create notification element
        const notification = document.createElement('div');
        notification.className = `file-notification ${type}`;
        
        // Add icon based on type
        let icon = 'info-circle';
        if (type === 'success') icon = 'check-circle';
        if (type === 'error') icon = 'exclamation-circle';
        if (type === 'uploading') icon = 'sync fa-spin';
        
        notification.innerHTML = `
            <i class="fas fa-${icon}"></i>
            <span>${message}</span>
        `;
        
        // Add to container
        const container = document.querySelector('.chat-messages');
        container.appendChild(notification);
        
        // Show with animation
        setTimeout(() => {
            notification.classList.add('show');
        }, 10);
        
        // Remove after delay unless it's an uploading notification
        if (type !== 'uploading') {
            setTimeout(() => {
                notification.classList.remove('show');
                setTimeout(() => notification.remove(), 300);
            }, 5000);
        }
        
        return notification;
    }

    // Function to add a message to the chat
    // Function to check if a message contains tool-related content
    function checkForToolMention(message) {
        if (!message) return null;
        
        const toolPatterns = [
            /(?:calling|using|executing|running)\s+(?:the\s+)?(\w+)\s+(?:function|tool)/i,
            /I'll\s+(?:now\s+)?(?:use|call|execute)\s+(?:the\s+)?(\w+)/i,
            /Let\s+me\s+(?:use|call|execute)\s+(?:the\s+)?(\w+)/i,
            /(\w+)\s+function\s+(?:to|will)/i
        ];
        
        const knownTools = [
            'extract_features', 'extract_personas', 'get_features', 'get_personas',
            'save_implementation', 'execute_command', 'start_server', 'create_implementation',
            'update_implementation', 'get_implementation', 'save_prd', 'get_prd'
        ];
        
        // Direct tool name check
        for (const tool of knownTools) {
            if (message.toLowerCase().includes(tool)) {
                return tool;
            }
        }
        
        // Pattern matching
        for (const pattern of toolPatterns) {
            const match = message.match(pattern);
            if (match && match[1]) {
                const toolName = match[1].toLowerCase();
                if (knownTools.includes(toolName)) {
                    return toolName;
                }
            }
        }
        
        return null;
    }
    
    function addMessageToChat(role, content, fileData = null, userRole = null, isPartial = false) {
        // Skip adding empty messages unless there's an audio indicator
        if (!content || content.trim() === '') {
            if (!fileData || !fileData.audioIndicator) {
                console.log(`Skipping empty ${role} message`);
                return;
            }
        }
        
        // Check for tool mentions in AI messages
        if (role === 'assistant') {
            const detectedTool = checkForToolMention(content);
            if (detectedTool && !document.querySelector('.tool-execution-indicator')) {
                console.log('Tool detected in complete message:', detectedTool);
                window.triggerToolAnimation(detectedTool);
            }
            
            // Check for audio transcription in the response
            const transcription = extractAudioTranscription(content);
            console.log('Checking for transcription. Found:', transcription, 'Last audio element:', window.lastAudioMessageElement);
            
            if (transcription && window.lastAudioMessageElement) {
                // Update the last audio message with transcription
                const transcriptionDiv = window.lastAudioMessageElement.querySelector('.audio-transcription');
                console.log('Found transcription div:', transcriptionDiv);
                if (transcriptionDiv) {
                    transcriptionDiv.textContent = transcription;
                    transcriptionDiv.style.display = 'block';
                    console.log('Updated transcription display');
                }
                // Clear the reference
                window.lastAudioMessageElement = null;
            }
        }
        
        // Detect scheduled / webhook / manual trigger prefix and strip it for display.
        // Format: "[Scheduled run · <trigger> · <ISO timestamp>] <actual prompt>"
        // Set by services/agent-runner.ts so the LLM (and now the UI) can tell
        // a cron/webhook fire apart from a real user message.
        let scheduledMeta = null;
        const scheduledMatch = content.match(/^\[Scheduled run · (\w+) · ([^\]]+)\]\s*([\s\S]*)$/);
        if (scheduledMatch) {
            scheduledMeta = { trigger: scheduledMatch[1], timestamp: scheduledMatch[2] };
            content = scheduledMatch[3];
        }

        // Strip the agent-mode file-context suffix we append in sendMessageToServer.
        // It's wire-only context for the LLM; the user's bubble shouldn't show it
        // on first render OR on history reload. Format:
        //   "...user text...\n\n[Attached file: NAME — available in the sandbox
        //    at /root/data/NAME and downloadable from the Data Room. Read it
        //    directly with pandas / openpyxl / etc.]"
        content = content.replace(/\s*\[Attached file: [^\]]+\]\s*$/s, "").trimEnd();

        // Create message element
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${role}`;

        if (scheduledMeta) {
            messageDiv.classList.add('scheduled-run');
            messageDiv.dataset.trigger = scheduledMeta.trigger;
            messageDiv.dataset.scheduledAt = scheduledMeta.timestamp;
        }

        // If this is a partial message, add a special class
        if (isPartial) {
            messageDiv.classList.add('partial-message');
        }

        // If this is a user message and userRole is provided, add it as a data attribute
        if (role === 'user' && userRole) {
            messageDiv.dataset.userRole = userRole;
        }

        // Create message content
        const contentDiv = document.createElement('div');
        contentDiv.className = 'message-content';
        contentDiv.setAttribute('data-raw-content', content);
        
        // Use marked.js to render markdown for assistant messages
        if (role === 'assistant' || role === 'system') {
            contentDiv.innerHTML = marked.parse(content);
        } else {
            // For user messages, escape HTML and preserve line breaks
            const escapedContent = content
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;')
                // .replace(/\n/g, '<br>');
            contentDiv.innerHTML = escapedContent;

            
            // Add file attachment indicator(s) if fileData is provided. fileData may be a
            // single object (legacy / audio) OR an array (multi-attach, up to 4).
            const renderOneFile = (fd) => {
                if (!fd) return;
                if (fd.type && fd.type.startsWith('image/') && (fd.previewUrl || fd.url)) {
                    // Image → render an inline thumbnail (like the preview screenshot).
                    const src = fd.previewUrl || fd.url;
                    const link = document.createElement('a');
                    link.href = fd.url || src;
                    link.target = '_blank';
                    link.rel = 'noopener';
                    const img = document.createElement('img');
                    img.src = src;
                    img.alt = fd.name || 'image';
                    link.appendChild(img);
                    contentDiv.appendChild(document.createElement('br'));
                    contentDiv.appendChild(link);
                } else if (fd.name) {
                    const fileAttachment = document.createElement('div');
                    fileAttachment.className = 'file-attachment';
                    fileAttachment.innerHTML = `
                        <i class="fas fa-paperclip"></i>
                        <span class="file-name">${fd.name}</span>
                        <span class="file-type">${fd.type}</span>
                    `;
                    contentDiv.appendChild(document.createElement('br'));
                    contentDiv.appendChild(fileAttachment);
                }
            };
            if (fileData) {
                if (Array.isArray(fileData)) {
                    fileData.forEach(renderOneFile);
                } else if (fileData.audioIndicator) {
                    // For audio messages, replace the entire content
                    contentDiv.innerHTML = '';
                    contentDiv.appendChild(fileData.audioIndicator);
                } else {
                    renderOneFile(fileData);
                }
            }
        }
        
        // Prepend a "scheduled trigger" badge if this message came from a non-chat fire
        if (scheduledMeta) {
            const t = new Date(scheduledMeta.timestamp);
            const timeStr = isNaN(t.getTime())
                ? scheduledMeta.timestamp
                : t.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });
            const label = scheduledMeta.trigger === 'cron' ? 'Scheduled run' :
                          scheduledMeta.trigger === 'webhook' ? 'Webhook trigger' :
                          scheduledMeta.trigger === 'manual' ? 'Manual run' :
                          scheduledMeta.trigger === 'start' ? 'Start trigger' : 'Triggered';
            contentDiv.insertAdjacentHTML('afterbegin',
                '<div class="scheduled-badge"><i class="fas fa-clock"></i> ' + label + ' · ' + timeStr + '</div>'
            );
        }

        // Create copy button
        const copyButton = document.createElement('button');
        copyButton.className = 'message-copy-btn';
        copyButton.innerHTML = '<i class="fas fa-copy"></i>';
        copyButton.title = 'Copy message';
        copyButton.onclick = function() {
            copyMessageToClipboard(content, this);
        };
        
        // Create a message actions container
        const messageActions = document.createElement('div');
        messageActions.className = 'message-actions';
        messageActions.appendChild(copyButton);
        
        // Append elements
        messageDiv.appendChild(contentDiv);
        messageDiv.appendChild(messageActions);
        
        // Add partial message indicator if needed
        if (isPartial) {
            const partialIndicator = document.createElement('div');
            partialIndicator.className = 'partial-indicator';
            partialIndicator.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> <span>Message in progress...</span>';
            messageDiv.appendChild(partialIndicator);
        }
        
        messageContainer.appendChild(messageDiv);
        
        // Remove typing indicator if it exists
        const typingIndicator = document.querySelector('.typing-indicator');
        if (typingIndicator) {
            typingIndicator.remove();
        }
        
        // Return the message element for reference
        return messageDiv;
    }
    
    // Function to copy message to clipboard
    function copyMessageToClipboard(content, button) {
        // Use the Clipboard API if available
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(content).then(() => {
                // Show success feedback
                const originalHTML = button.innerHTML;
                button.innerHTML = '<i class="fas fa-check"></i>';
                button.classList.add('copied');
                
                setTimeout(() => {
                    button.innerHTML = originalHTML;
                    button.classList.remove('copied');
                }, 2000);
            }).catch(err => {
                console.error('Failed to copy text: ', err);
                // Fallback to older method
                fallbackCopyToClipboard(content, button);
            });
        } else {
            // Fallback for older browsers or non-secure contexts
            fallbackCopyToClipboard(content, button);
        }
    }
    
    // Fallback copy method for older browsers
    function fallbackCopyToClipboard(content, button) {
        const textArea = document.createElement("textarea");
        textArea.value = content;
        textArea.style.position = "fixed";
        textArea.style.left = "-999999px";
        textArea.style.top = "-999999px";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        
        try {
            document.execCommand('copy');
            // Show success feedback
            const originalHTML = button.innerHTML;
            button.innerHTML = '<i class="fas fa-check"></i>';
            button.classList.add('copied');
            
            setTimeout(() => {
                button.innerHTML = originalHTML;
                button.classList.remove('copied');
            }, 2000);
        } catch (err) {
            console.error('Failed to copy text: ', err);
            alert('Failed to copy message');
        }
        
        document.body.removeChild(textArea);
    }
    
    // Function to show a function call indicator
    // Read/inspect tools are grouped under a steady "Gathering information…" header so the
    // indicator stays PUT (no flicker) while the agent investigates; the specific action
    // (which file / preview command / branch) shows on a second line via tool_detail.
    const INVESTIGATION_TOOLS = new Set([
        'queryCodebase', 'inspectPreview', 'getFileContent', 'getFileList',
        'getRecentActivities', 'getTicketDetails', 'getPendingTickets', 'getProjectContext',
    ]);

    // Persistent status indicator. If one already exists we UPDATE it in place instead of
    // remove+re-add — that flicker (pill popping on/off between tool calls) is exactly what
    // made it unreadable. It only clears when the final answer starts streaming.
    function showFunctionCallIndicator(functionName, opts) {
        opts = opts || {};
        const investigation = !!opts.investigation || INVESTIGATION_TOOLS.has(functionName);
        const details = getFunctionDetails(functionName);
        // ONE stable header for the whole turn — "Working…" — with the specific
        // action on the detail line. Swapping the header per tool made the pill
        // churn through half a dozen labels while nothing visibly progressed.
        const label = 'Working';
        const icon = investigation ? 'fa-magnifying-glass' : (details.icon || 'fa-cog');
        const color = investigation ? '#a78bfa' : (details.color || '#94a3b8');
        const detailText = opts.detail || details.label || (investigation ? 'Gathering information' : '');

        return trailStep({ icon, color, detail: detailText, label });
    }

    // ── The working trail ────────────────────────────────────────────────────
    //
    // One pill that rewrote itself told you the agent was busy and nothing else — on a
    // large codebase it sat on "Reading the codebase" for minutes while a dozen distinct
    // things happened underneath. The trail ACCUMULATES those steps on a connected line,
    // so you can see what it's actually doing, and it stays in the transcript afterwards
    // (collapsed) so you can go back and read what happened.
    let activeTrail = null;

    function trailStep(step) {
        if (!activeTrail || !activeTrail.isConnected) {
            activeTrail = document.createElement('div');
            activeTrail.className = 'agent-trail is-running';
            activeTrail.dataset.started = String(Date.now());
            activeTrail.innerHTML = `
                <button type="button" class="agent-trail-head" aria-expanded="true">
                    <span class="agent-trail-spinner"></span>
                    <span class="agent-trail-title">Working</span>
                    <span class="agent-trail-meta"></span>
                    <i class="fas fa-chevron-down agent-trail-caret"></i>
                </button>
                <div class="agent-trail-steps"></div>`;
            activeTrail.querySelector('.agent-trail-head').addEventListener('click', function () {
                const collapsed = activeTrail_toggle(this.closest('.agent-trail'));
                this.setAttribute('aria-expanded', String(!collapsed));
            });
            messageContainer.appendChild(activeTrail);
        }

        const steps = activeTrail.querySelector('.agent-trail-steps');
        const text = step.detail || step.label || 'Working';
        const last = steps.lastElementChild;
        // Don't stack the same line twice — a tool that reports progress repeatedly
        // should update its row, not add another identical one.
        if (last && last.dataset.text === text) {
            last.classList.add('is-current');
            return activeTrail;
        }
        if (last) last.classList.remove('is-current');

        const row = document.createElement('div');
        row.className = 'agent-trail-step is-current';
        row.dataset.text = text;
        row.innerHTML = `
            <span class="agent-trail-dot" style="--tool-color:${step.color || '#94a3b8'}">
                <i class="fas ${step.icon || 'fa-cog'}"></i>
            </span>
            <span class="agent-trail-text"></span>`;
        row.querySelector('.agent-trail-text').textContent = text;
        steps.appendChild(row);
        updateTrailMeta(activeTrail);
        scrollToBottom();
        return activeTrail;
    }

    function activeTrail_toggle(trail) {
        if (!trail) return false;
        const collapsed = trail.classList.toggle('is-collapsed');
        return collapsed;
    }

    function updateTrailMeta(trail) {
        if (!trail) return;
        const count = trail.querySelectorAll('.agent-trail-step').length;
        const secs = Math.max(1, Math.round((Date.now() - Number(trail.dataset.started || Date.now())) / 1000));
        const meta = trail.querySelector('.agent-trail-meta');
        if (meta) meta.textContent = count + (count === 1 ? ' step' : ' steps') + ' · ' + secs + 's';
    }

    /** The turn is over: stamp the trail, collapse it, and leave it in the transcript. */
    function finalizeTrail() {
        if (!activeTrail || !activeTrail.isConnected) { activeTrail = null; return; }
        const trail = activeTrail;
        activeTrail = null;
        updateTrailMeta(trail);
        trail.classList.remove('is-running');
        trail.classList.add('is-done', 'is-collapsed');
        const title = trail.querySelector('.agent-trail-title');
        if (title) title.textContent = 'Worked';
        const head = trail.querySelector('.agent-trail-head');
        if (head) head.setAttribute('aria-expanded', 'false');
        const current = trail.querySelector('.agent-trail-step.is-current');
        if (current) current.classList.remove('is-current');
    }

    // Update just the second line of the live indicator (the specific action).
    function setToolDetail(indicator, text) {
        // The detail line WAS the pill's second row; it's a step on the trail now, so a
        // stream of details reads as a sequence instead of overwriting itself.
        if (!text) return;
        trailStep({ detail: text, icon: 'fa-magnifying-glass', color: '#a78bfa' });
    }
    
    // Function to show a function call success message
    function showFunctionCallSuccess(functionName, type) {
        // Remove any existing function call indicators
        removeFunctionCallIndicator();
        
        // Get function details
        const functionDetails = getFunctionDetails(functionName);
        
        // Create the success element
        const successElement = document.createElement('div');
        successElement.className = 'function-call-success';
        
        // Add function-specific class for styling
        const functionType = functionName.includes('features') ? 'features' :
                           functionName.includes('personas') ? 'personas' :
                           functionName.includes('implementation') ? 'implementation' :
                           functionName === 'execute_command' ? 'execute_command' :
                           functionName === 'start_server' ? 'start_server' :
                           type || 'generic';
        successElement.classList.add(`function-${functionType}`);
        
        let message = '';
        if (type === 'features') {
            message = 'Features extracted and saved successfully!';
        } else if (type === 'personas') {
            message = 'Personas extracted and saved successfully!';
        } else if (type === 'prd') {
            message = 'PRD generated and saved successfully!';
        } else if (type === 'command_output' || functionName === 'execute_command') {
            message = 'Command executed successfully!';
        } else if (type === 'implementation') {
            message = 'Implementation saved successfully!';
        } else if (type === 'design') {
            message = 'Design schema created successfully!';
        } else if (type === 'tickets') {
            message = 'Tickets generated successfully!';
        } else if (type === 'checklist') {
            message = 'Checklist updated successfully!';
        } else {
            message = 'Function call completed successfully!';
        }
        
        successElement.innerHTML = `
            <div class="function-call-icon">✓</div>
            <div class="function-call-text">
                <div class="function-name">${functionName}()</div>
                <div class="function-result">
                    ${message}<br>
                    <small>${functionDetails.successMessage || 'Results have been processed and saved.'}</small>
                </div>
            </div>
        `;
        
        // Add to message container
        messageContainer.appendChild(successElement);
        scrollToBottom();
        
        // Remove after a delay
        setTimeout(() => {
            if (successElement.parentNode) {
                successElement.classList.add('fade-out');
                setTimeout(() => {
                    if (successElement.parentNode) {
                        successElement.remove();
                    }
                }, 500); // fade out time
            }
        }, 4000); // show for 4 seconds
    }

    // Function to add a permanent mini indicator of function call success
    function addFunctionCallMiniIndicator(functionName, type) {
        // Create mini indicator
        const miniIndicator = document.createElement('div');
        miniIndicator.className = 'function-mini-indicator';
        
        let icon = '';
        if (type === 'features') icon = '📋';
        else if (type === 'personas') icon = '👥';
        else if (type === 'prd') icon = '📄';
        else icon = '✓';
        
        miniIndicator.innerHTML = `
            <span class="mini-icon">${icon}</span>
            <span class="mini-name">${functionName}</span>
        `;
        
        // Add it to the message container
        messageContainer.appendChild(miniIndicator);
        
        // Add fade-in animation
        setTimeout(() => {
            miniIndicator.classList.add('show');
        }, 100);
    }
    
    // Helper function to get function details for UI display
    function getFunctionDetails(functionName) {
        const functionDetails = {
            'extract_features': {
                label: 'Extracting features',
                icon: 'fa-layer-group',
                color: '#a78bfa',
            },
            'extract_personas': {
                label: 'Extracting personas',
                icon: 'fa-users',
                color: '#f472b6',
            },
            'get_features': {
                label: 'Loading features',
                icon: 'fa-layer-group',
                color: '#a78bfa',
            },
            'get_personas': {
                label: 'Loading personas',
                icon: 'fa-users',
                color: '#f472b6',
            },
            'extract_prd': {
                label: 'Generating PRD',
                icon: 'fa-file-alt',
                color: '#60a5fa',
            },
            'get_prd': {
                label: 'Loading PRD',
                icon: 'fa-file-alt',
                color: '#60a5fa',
            },
            'execute_command': {
                label: 'Running command',
                icon: 'fa-terminal',
                color: '#fbbf24',
            },
            'start_server': {
                label: 'Starting server',
                icon: 'fa-server',
                color: '#34d399',
            },
            'save_implementation': {
                label: 'Saving implementation',
                icon: 'fa-code',
                color: '#34d399',
            },
            'create_prd': {
                label: 'Creating PRD',
                icon: 'fa-file-alt',
                color: '#60a5fa',
            },
            'create_implementation': {
                label: 'Creating implementation plan',
                icon: 'fa-code',
                color: '#34d399',
            },
            'update_implementation': {
                label: 'Updating implementation',
                icon: 'fa-code',
                color: '#34d399',
            },
            'get_implementation': {
                label: 'Loading implementation',
                icon: 'fa-code',
                color: '#34d399',
            },
            'save_features': {
                label: 'Saving features',
                icon: 'fa-layer-group',
                color: '#a78bfa',
            },
            'save_personas': {
                label: 'Saving personas',
                icon: 'fa-users',
                color: '#f472b6',
            },
            'design_schema': {
                label: 'Designing database schema',
                icon: 'fa-database',
                color: '#fb923c',
            },
            'generate_tickets': {
                label: 'Generating tickets',
                icon: 'fa-ticket-alt',
                color: '#fb923c',
            },
            'checklist_tickets': {
                label: 'Creating ticket checklist',
                icon: 'fa-tasks',
                color: '#fb923c',
            },
            'update_checklist_ticket': {
                label: 'Updating checklist',
                icon: 'fa-tasks',
                color: '#fb923c',
            },
            'get_next_ticket': {
                label: 'Getting next ticket',
                icon: 'fa-ticket-alt',
                color: '#fb923c',
            },
            'implement_ticket': {
                label: 'Implementing ticket',
                icon: 'fa-hammer',
                color: '#fb923c',
            },
            'web_search': {
                label: 'Searching the web',
                icon: 'fa-globe',
                color: '#38bdf8',
            },
            'web_search_20250305': {
                label: 'Searching the web',
                icon: 'fa-globe',
                color: '#38bdf8',
            },
            'google_search': {
                label: 'Searching the web',
                icon: 'fa-globe',
                color: '#38bdf8',
            },
            'getProjectDashboard': {
                label: 'Loading project dashboard',
                icon: 'fa-th-large',
                color: '#94a3b8',
            },
            'lookupTechnologySpecs': {
                label: 'Researching technology',
                icon: 'fa-microscope',
                color: '#38bdf8',
            },
            'streamDocumentContent': {
                label: 'Writing document',
                icon: 'fa-pen-fancy',
                color: '#60a5fa',
            },
            'patchFileContent': {
                label: 'Editing document',
                icon: 'fa-edit',
                color: '#60a5fa',
            },
            'updateFileContent': {
                label: 'Updating document',
                icon: 'fa-file-alt',
                color: '#60a5fa',
            },
            'createTickets': {
                label: 'Creating tickets',
                icon: 'fa-ticket-alt',
                color: '#fb923c',
            },
            'scheduleTickets': {
                label: 'Scheduling tickets',
                icon: 'fa-calendar-alt',
                color: '#fb923c',
            },
            'savePRD': {
                label: 'Saving PRD',
                icon: 'fa-file-alt',
                color: '#60a5fa',
            },
            'getFileList': {
                label: 'Checking project files',
                icon: 'fa-folder-open',
                color: '#94a3b8',
            },
            'getFileContent': {
                label: 'Reading file',
                icon: 'fa-file-code',
                color: '#94a3b8',
            },
            'setProjectStack': {
                label: 'Setting tech stack',
                icon: 'fa-layer-group',
                color: '#a78bfa',
            },
            'getRecentActivities': {
                label: 'Checking recent activity',
                icon: 'fa-history',
                color: '#94a3b8',
            },
            'getTicketDetails': {
                label: 'Loading ticket details',
                icon: 'fa-ticket-alt',
                color: '#fb923c',
            },
            'retryTicket': {
                label: 'Retrying ticket',
                icon: 'fa-redo',
                color: '#fb923c',
            },
            'sendTicketMessage': {
                label: 'Messaging ticket',
                icon: 'fa-comment-dots',
                color: '#fb923c',
            },
        };

        // Fallback: auto-generate a label from the function name.
        const details = functionDetails[functionName];
        if (details) return details;

        // Composio tools are UPPER_SNAKE (e.g. COMPOSIO_MULTI_EXECUTE_TOOL,
        // GMAIL_SEND_EMAIL, SLACK_SEND_MESSAGE). The camelCase splitter below would
        // put a space before EVERY letter ("C o m p o s i o…"), so handle these
        // explicitly: strip a COMPOSIO_ prefix, words come from the underscores.
        if (/^[A-Z0-9]+(_[A-Z0-9]+)+$/.test(functionName)) {
            if (functionName === 'COMPOSIO_MULTI_EXECUTE_TOOL' || functionName === 'COMPOSIO_EXECUTE_TOOL') {
                return { label: 'Using connected tools', icon: 'fa-plug', color: '#38bdf8' };
            }
            const words = functionName.replace(/^COMPOSIO_/, '').split('_');
            const cLabel = words.join(' ').toLowerCase().replace(/^./, c => c.toUpperCase());
            return { label: cLabel, icon: 'fa-plug', color: '#38bdf8' };
        }

        const label = functionName
            .replace(/([A-Z])/g, ' $1')
            .replace(/_/g, ' ')
            .replace(/^\s+/, '')
            .replace(/\s+/g, ' ')
            .toLowerCase()
            .replace(/^./, c => c.toUpperCase());
        return { label, icon: 'fa-cog', color: '#94a3b8' };
    }
    
    // Function to remove any function call indicators
    // instant=true skips animation (used when replacing with a new pill)
    // force=true removes even mid-turn — for the events that genuinely END the
    // work: turn complete, stop, error, or a blocking question to the user.
    // Without force, a call while the assistant is still working is IGNORED:
    // tool-completion notifications used to tear the pill down and the next tool
    // rebuilt it, which is what made it flash on and off all turn.
    function removeFunctionCallIndicator(instant = false, force = false) {
        if (turnActive && !force) return;
        // The trail is KEPT — collapsed, with its steps intact — because the whole point
        // is being able to go back and see what the agent did. Only the legacy pills go.
        finalizeTrail();
        const existingIndicators = document.querySelectorAll('.function-call-indicator, .function-call-success');
        existingIndicators.forEach(indicator => {
            if (instant) {
                indicator.remove();
                return;
            }
            // Fade out, then remove
            indicator.classList.add('tool-pill-exit');
            indicator.addEventListener('animationend', () => indicator.remove(), { once: true });
            // Safety fallback in case animationend doesn't fire
            setTimeout(() => { if (indicator.parentNode) indicator.remove(); }, 350);
        });
    }
    
    // Add new function to detect function calls in text and show indicators
    function checkForFunctionCall(text) {
        // More comprehensive patterns to detect function calls in the AI's text
        const patterns = [
            // Standard function call patterns
            /(?:I'll|I will|Let me|I'm going to|I am going to)\s+(?:call|use|execute|run)\s+(?:the\s+)?`?(\w+)`?\s+function/i,
            
            // Direct function mentions
            /(?:calling|executing|running|using)\s+(?:the\s+)?`?(\w+)`?\s+function/i,
            
            // Code block style mentions
            /```(?:python|js|javascript)?\s*(?:function\s+)?(\w+)\s*\(/i,
            
            // Now let's/I'm extracting patterns
            /(?:Now|I'm|I am)\s+(?:extracting|getting)\s+(?:the\s+)?(\w+)/i,
            
            // Calling with specific syntax
            /(?:extract_(\w+)|get_(\w+))\(/i
        ];
        
        // Check each pattern
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match) {
                let functionName = '';
                
                // Special case for the last pattern with capturing groups
                if (pattern.toString().includes('extract_') && (match[1] || match[2])) {
                    functionName = match[1] ? `extract_${match[1]}` : `get_${match[2]}`;
                } else if (match[1]) {
                    functionName = match[1].toLowerCase();
                    
                    // Handle some common variations
                    if (functionName === 'extract' || functionName === 'extracting') functionName = 'extract_features';
                    if (functionName === 'features') functionName = 'extract_features';
                    if (functionName === 'personas') functionName = 'extract_personas';
                    if (functionName === 'prd') functionName = 'extract_prd';
                }
                
                // Only show for known functions to avoid false positives
                const knownFunctions = ['extract_features', 'extract_personas', 'get_features', 'get_personas', 'extract_prd', 'get_prd', 'execute_command', 'start_server', 'save_implementation'];
                
                if (knownFunctions.includes(functionName)) {
                    showFunctionCallIndicator(functionName);
                    return; // Exit after finding the first match
                }
            }
        }
    }
    
    // Function to clear all messages from the chat
    function clearChatMessages() {
        messageContainer.innerHTML = '';
    }
    
    // Smart scroll management - tracks user intent
    let userScrolledUp = false;
    let lastScrollTop = 0;
    let scrollPending = false;
    const SCROLL_THRESHOLD = 100;

    // Detect user scroll intent
    chatMessages.addEventListener('scroll', function() {
        const currentScrollTop = chatMessages.scrollTop;
        const distanceFromBottom = chatMessages.scrollHeight - currentScrollTop - chatMessages.clientHeight;

        // User scrolled UP (away from bottom)
        if (currentScrollTop < lastScrollTop && distanceFromBottom > SCROLL_THRESHOLD) {
            userScrolledUp = true;
        }
        // User scrolled back to bottom
        else if (distanceFromBottom < 50) {
            userScrolledUp = false;
        }

        lastScrollTop = currentScrollTop;
    });

    // Function to scroll to the bottom of the chat
    // Find the last .message.assistant in the container, regardless of other
    // elements (indicators, typing dots) appended after it.
    function getLastAssistantMessage() {
        const all = messageContainer.querySelectorAll('.message.assistant');
        return all.length ? all[all.length - 1] : null;
    }

    function scrollToBottom(force = false) {
        if (force) {
            userScrolledUp = false;
            chatMessages.scrollTop = chatMessages.scrollHeight;
            lastScrollTop = chatMessages.scrollTop;
            return;
        }

        if (userScrolledUp || scrollPending) {
            return;
        }

        // Batch scroll updates to once per frame for smoothness
        scrollPending = true;
        requestAnimationFrame(() => {
            if (!userScrolledUp) {
                chatMessages.scrollTop = chatMessages.scrollHeight;
                lastScrollTop = chatMessages.scrollTop;
            }
            scrollPending = false;
        });
    }
    
    // Function to handle tool progress updates
    function handleToolProgress(data) {
        const { tool_name, message, progress_percentage } = data;
        
        // Find or create progress indicator
        let progressIndicator = document.querySelector('.tool-progress-indicator');
        if (!progressIndicator) {
            progressIndicator = document.createElement('div');
            progressIndicator.className = 'tool-progress-indicator';
            messageContainer.appendChild(progressIndicator);
        }
        
        // Update progress UI
        let progressBar = '';
        if (progress_percentage !== null && progress_percentage >= 0) {
            progressBar = `
                <div class="progress-bar-container">
                    <div class="progress-bar" style="width: ${progress_percentage}%"></div>
                </div>
            `;
        }
        
        // Error state
        const isError = progress_percentage < 0;
        const statusClass = isError ? 'error' : (progress_percentage === 100 ? 'success' : 'active');
        
        progressIndicator.className = `tool-progress-indicator ${statusClass}`;
        progressIndicator.innerHTML = `
            <div class="tool-progress-content">
                <div class="tool-progress-header">
                    <i class="fas ${isError ? 'fa-exclamation-circle' : (progress_percentage === 100 ? 'fa-check-circle' : 'fa-cog fa-spin')}"></i>
                    <span class="tool-name">${tool_name}</span>
                </div>
                <div class="tool-progress-message">${message}</div>
                ${progressBar}
            </div>
        `;
        
        // Remove on completion or error
        if (progress_percentage === 100 || progress_percentage < 0) {
            setTimeout(() => {
                progressIndicator.classList.add('fade-out');
                setTimeout(() => progressIndicator.remove(), 500);
            }, 2000);
        }
        
        scrollToBottom();
    }
    
    // Heartbeat and connection monitoring functions
    function startHeartbeat() {
        // Clear any existing interval
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
        }
        
        lastHeartbeatResponse = Date.now();
    }
    
    function stopHeartbeat() {
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = null;
        }
    }
    
    function startConnectionMonitor() {
        connectionMonitorInterval = setInterval(() => {
            const timeSinceLastHeartbeat = Date.now() - lastHeartbeatResponse;
            
            // Be more lenient during streaming operations
            const heartbeatTimeout = isStreaming ? 120000 : 60000;  // 2 minutes during streaming, 1 minute otherwise
            
            if (timeSinceLastHeartbeat > heartbeatTimeout) {
                console.warn(`No heartbeat received for ${heartbeatTimeout/1000} seconds, connection may be dead`);
                showConnectionStatus('unstable');
                
                // Force reconnect
                if (socket && socket.readyState === WebSocket.OPEN) {
                    socket.close();
                }
            }
        }, 5000);  // Check every 5 seconds
    }
    
    function stopConnectionMonitor() {
        if (connectionMonitorInterval) {
            clearInterval(connectionMonitorInterval);
            connectionMonitorInterval = null;
        }
    }
    
    function showConnectionStatus(status, current = 0, max = 0) {
        return;
        let statusElement = document.querySelector('.connection-status');
        if (!statusElement) {
            statusElement = document.createElement('div');
            statusElement.className = 'connection-status';
            document.body.appendChild(statusElement);
        }
        
        switch (status) {
            case 'disconnected':
                statusElement.innerHTML = `
                    <i class="fas fa-exclamation-triangle"></i>
                    <span>Connection lost. Attempting to reconnect...</span>
                `;
                statusElement.className = 'connection-status warning';
                break;
                
            case 'reconnecting':
                statusElement.innerHTML = `
                    <i class="fas fa-sync fa-spin"></i>
                    <span>Reconnecting... (${current}/${max})</span>
                `;
                statusElement.className = 'connection-status warning';
                break;
                
            case 'failed':
                statusElement.innerHTML = `
                    <i class="fas fa-times-circle"></i>
                    <span>Connection failed. Please refresh the page.</span>
                    <button onclick="location.reload()" class="refresh-btn">Refresh</button>
                `;
                statusElement.className = 'connection-status error';
                break;
                
            case 'unstable':
                statusElement.innerHTML = `
                    <i class="fas fa-wifi"></i>
                    <span>Connection unstable...</span>
                `;
                statusElement.className = 'connection-status warning';
                break;
                
            // case 'connected':
            //     statusElement.innerHTML = `
            //         <i class="fas fa-check-circle"></i>
            //         <span>Connected</span>
            //     `;
            //     statusElement.className = 'connection-status success';
            //     setTimeout(() => {
            //         statusElement.classList.add('fade-out');
            //         setTimeout(() => statusElement.remove(), 500);
            //     }, 3000);
            //     break;
        }
    }
    
    // Draft message management
    function saveDraftMessage(message) {
        if (message && message.trim()) {
            const draftData = {
                message: message,
                conversationId: currentConversationId || '',
                timestamp: Date.now()
            };
            localStorage.setItem('chat_draft', JSON.stringify(draftData));
        }
    }
    
    function loadDraftMessage() {
        try {
            const draftJson = localStorage.getItem('chat_draft');
            if (draftJson) {
                const draftData = JSON.parse(draftJson);
                
                // Check if draft is less than 24 hours old
                const ageInHours = (Date.now() - draftData.timestamp) / (1000 * 60 * 60);
                if (ageInHours < 24 && draftData.conversationId === (currentConversationId || '')) {
                    chatInput.value = draftData.message;
                    
                    // Show draft indicator
                    const draftIndicator = document.createElement('div');
                    draftIndicator.className = 'draft-indicator';
                    draftIndicator.innerHTML = `
                        <i class="fas fa-info-circle"></i>
                        Draft message restored
                        <button onclick="clearDraftMessage(); this.parentElement.remove();" class="clear-draft">
                            <i class="fas fa-times"></i>
                        </button>
                    `;
                    chatInput.parentElement.appendChild(draftIndicator);
                    
                    setTimeout(() => {
                        if (draftIndicator.parentNode) {
                            draftIndicator.classList.add('fade-out');
                            setTimeout(() => draftIndicator.remove(), 500);
                        }
                    }, 5000);
                } else {
                    // Clear old draft
                    clearDraftMessage();
                }
            }
        } catch (e) {
            console.error('Error loading draft:', e);
        }
    }
    
    function clearDraftMessage() {
        localStorage.removeItem('chat_draft');
    }
    
    // Make clearDraftMessage available globally for onclick handler
    window.clearDraftMessage = clearDraftMessage;
    
    // Auto-save draft as user types (debounced)
    chatInput.addEventListener('input', debounce(function() {
        if (this.value.trim()) {
            saveDraftMessage(this.value);
        }
    }, 1000));
    
    // Clear draft when message is sent successfully
    const originalSendMessage = sendMessage;
    sendMessage = function(message) {
        const result = originalSendMessage(message);
        // Clear draft after successful send
        if (result !== false) {
            clearDraftMessage();
        }
        return result;
    };
    
    // Utility function for debouncing
    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func.apply(this, args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }
    
    // Add event listener for beforeunload to save draft
    window.addEventListener('beforeunload', () => {
        if (chatInput.value.trim()) {
            saveDraftMessage(chatInput.value);
        }
    });
    
    // Load draft on DOMContentLoaded
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => {
            loadDraftMessage();
        }, 100);
    });
    
    // Test function for tool progress (for debugging)
    window.testToolProgress = function() {
        console.log('Testing tool progress indicator...');
        const progressSteps = [
            { message: "Starting extraction...", percentage: 10 },
            { message: "Analyzing data...", percentage: 40 },
            { message: "Processing results...", percentage: 70 },
            { message: "Saving to database...", percentage: 90 },
            { message: "Complete!", percentage: 100 }
        ];
        
        progressSteps.forEach((step, index) => {
            setTimeout(() => {
                console.log(`Sending progress: ${step.message} (${step.percentage}%)`);
                handleToolProgress({
                    tool_name: 'test_function',
                    message: step.message,
                    progress_percentage: step.percentage
                });
            }, index * 1000);
        });
    };
    
    // Test all animations
    // window.testAllAnimations = function() {
    //     console.log('Testing all tool animations...');
        
    //     // 1. Show tool execution indicator
    //     console.log('1. Showing tool execution indicator...');
    //     window.showToolExecutionIndicator('extract_features');
        
    //     // 2. Show function call indicator after 1 second
    //     setTimeout(() => {
    //         console.log('2. Showing function call indicator...');
    //         showFunctionCallIndicator('extract_features');
    //     }, 1000);
        
    //     // 3. Show tool progress after 2 seconds
    //     setTimeout(() => {
    //         console.log('3. Starting tool progress...');
    //         window.testToolProgress();
    //     }, 2000);
        
    //     // 4. Clean up after 8 seconds
    //     setTimeout(() => {
    //         console.log('4. Cleaning up...');
    //         document.querySelector('.tool-execution-indicator')?.remove();
    //         removeFunctionCallIndicator();
    //         document.querySelector('.tool-progress-indicator')?.remove();
    //     }, 8000);
    // };
    
    // Simple function to show a tool execution indicator
    window.showToolExecutionIndicator = function(toolName) {
        // Remove any existing indicators
        const existing = document.querySelector('.tool-execution-indicator');
        if (existing) existing.remove();
        
        const indicator = document.createElement('div');
        indicator.className = 'tool-execution-indicator';
        indicator.innerHTML = `
            <div class="tool-execution-content">
                <div class="tool-execution-spinner"></div>
                <div class="tool-execution-text">
                    <div class="tool-execution-title">Executing Tool</div>
                    <div class="tool-execution-name">${toolName || 'Processing...'}</div>
                </div>
            </div>
        `;
        
        messageContainer.appendChild(indicator);
        scrollToBottom();
        
        return indicator;
    };
    
    // Function to load conversation list
    async function loadConversations() {
        try {
            // First check path for project ID since we're in project context
            const pathProjectId = extractProjectIdFromPath();
            
            if (!pathProjectId) {
                throw new Error('No project ID found in path. Expected format: /chat/project/{id}/');
            }
            
            // Build the URL with project_id
            const url = `/api/projects/${pathProjectId}/conversations/`;
            console.log('Loading conversations for project:', pathProjectId);
            
            const response = await fetch(url);
            const conversations = await response.json();
            
            // Clear the conversation list
            conversationList.innerHTML = '';
            
            // Add conversations to the list
            conversations.forEach(conversation => {
                const conversationItem = createCompactConversationItem(conversation);
                
                // Add active class if this is the current conversation
                if (conversation.id === currentConversationId) {
                    conversationItem.classList.add('active');
                }
                
                // Add click handler
                conversationItem.addEventListener('click', () => {
                    loadConversation(conversation.id);
                });
                
                // Add delete handler — absent on a teammate's shared chat.
                const deleteBtn = conversationItem.querySelector('.delete-conversation');
                if (deleteBtn) {
                    deleteBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        deleteConversation(conversation.id);
                    });
                }
                
                conversationList.appendChild(conversationItem);
            });
            
            // If sidebar is empty, add a message
            if (conversations.length === 0) {
                const emptyMessage = document.createElement('div');
                emptyMessage.className = 'empty-conversations-message';
                emptyMessage.textContent = 'No conversations yet. Start chatting!';
                conversationList.appendChild(emptyMessage);
            }
        } catch (error) {
            console.error('Error loading conversations:', error);
        }
    }
    
    // Function to load a specific conversation
    async function loadConversation(conversationId) {
        try {
            console.log('[loadConversation] fetching:', `/api/conversations/${conversationId}`);
            const response = await fetch(`/api/conversations/${conversationId}`);
            console.log('[loadConversation] response status:', response.status);
            if (!response.ok) {
                console.error('[loadConversation] Failed:', response.status, await response.text());
                return;
            }
            const data = await response.json();
            console.log('[loadConversation] got data, messages:', data.messages?.length);
            if (!data || !data.messages) {
                console.error('[loadConversation] Invalid data:', data);
                return;
            }

            // Set current conversation ID
            currentConversationId = conversationId;
            window.currentConversationId = currentConversationId;  // Sync to global
            conversationLoadedViaRest = true;

            // Clear chat
            clearChatMessages();

            // Set project ID if this conversation is linked to a project
            if (data.project) {
                currentProjectId = data.project.id;
            }

            // Add each message to the chat
            let rendered = 0;
            data.messages.forEach(message => {
                // Restore an attached image (if any) so it persists across reloads.
                let fileData = null;
                const cif = message.content_if_file;
                if (Array.isArray(cif) && cif.length && (cif[0].type || '').startsWith('image/') && cif[0].url) {
                    fileData = { name: cif[0].name, type: cif[0].type, url: cif[0].url };
                }
                if ((message.content && message.content.trim() !== '') || fileData) {
                    addMessageToChat(message.role, message.content || '', fileData);
                    rendered++;
                }
            });
            console.log('[loadConversation] rendered', rendered, 'messages');
            
            // Load files for this conversation
            loadMessageFiles(conversationId);
            
            // Mark this conversation as active in the sidebar
            document.querySelectorAll('.conversation-item').forEach(item => {
                if (item.dataset.id === conversationId) {
                    item.classList.add('active');
                } else {
                    item.classList.remove('active');
                }
            });
            
            // Update URL to reflect the loaded conversation
            const pathProjectId = extractProjectIdFromPath();
            if (pathProjectId) {
                // Use clean path format: /chat/project/:projectId/conversation/:conversationId
                const newPath = `/chat/project/${pathProjectId}/conversation/${conversationId}`;
                if (window.location.pathname !== newPath) {
                    window.history.pushState({}, '', newPath);
                }
            } else {
                const url = new URL(window.location);
                url.searchParams.set('conversation_id', conversationId);
                if (currentProjectId) {
                    url.searchParams.set('project_id', currentProjectId);
                }
                window.history.pushState({}, '', url);
            }

            // Force scroll to bottom when loading conversation
            scrollToBottom(true);
        } catch (error) {
            console.error('Error loading conversation:', error);
        }
    }

    // Function to set sidebar state - COMMENTED OUT: Using new sidebar.js system instead
    /*
    function setSidebarState(collapsed) {
        console.log("SIDEBAR!!!")
        const sidebar = document.getElementById('sidebar');
        
        if (collapsed) {
            sidebar.classList.remove('expanded');
            appContainer.classList.remove('sidebar-expanded');
        } else {
            sidebar.classList.add('expanded');
            appContainer.classList.add('sidebar-expanded');
        }
        
        // Store in localStorage
        localStorage.setItem('sidebar_collapsed', collapsed);
        
        // Save to server if user is logged in
        if (document.body.dataset.userAuthenticated === 'true') {
            fetch('/api/toggle-sidebar/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': getCsrfToken(),
                },
                body: JSON.stringify({ collapsed: collapsed }),
            });
        }
    }
    */

    // Close sidebar when overlay is clicked (mobile) - COMMENTED OUT: Handled by sidebar.js
    /*
    sidebarOverlay.addEventListener('click', () => {
        setSidebarState(true); // Collapse sidebar
    });
    */

    // Add a mobile toggle button - COMMENTED OUT: Handled by sidebar.js
    /*
    function addMobileToggle() {
        const mobileToggle = document.createElement('button');
        mobileToggle.className = 'mobile-sidebar-toggle';
        mobileToggle.innerHTML = '☰';
        mobileToggle.addEventListener('click', () => {
            const sidebar = document.getElementById('sidebar');
            const isCurrentlyExpanded = sidebar.classList.contains('expanded');
            setSidebarState(isCurrentlyExpanded); // Toggle sidebar state
        });
        document.body.appendChild(mobileToggle);
    }
    */

    // Call the initialization functions
    // Mobile toggle - COMMENTED OUT: Handled by sidebar.js
    /*
    if (window.innerWidth <= 768) {
        console.log("Mobile Toggle")
        addMobileToggle();
    }
    */

    // Helper function to get CSRF token
    function getCsrfToken() {
        // Try to get it from the meta tag first (Django's standard location)
        const metaToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content');
        if (metaToken) {
            console.log('Found CSRF token in meta tag');
            return metaToken;
        }
        
        // Then try the input field (another common location)
        const inputToken = document.querySelector('[name=csrfmiddlewaretoken]')?.value;
        if (inputToken) {
            console.log('Found CSRF token in input field');
            return inputToken;
        }
        
        // Finally try to get it from cookies
        const cookieValue = document.cookie
            .split('; ')
            .find(row => row.startsWith('csrftoken='))
            ?.split('=')[1];
        
        if (cookieValue) {
            console.log('Found CSRF token in cookies');
            return cookieValue;
        }
        
        console.error('CSRF token not found in any location');
        return '';
    }

    // Function to delete a conversation
    async function deleteConversation(conversationId) {
        if (!confirm('Are you sure you want to delete this conversation? This action cannot be undone.')) {
            return;
        }
        
        try {
            // Get CSRF token
            const csrfToken = getCsrfToken();
            
            // Send delete request
            const response = await fetch(`/api/conversations/${conversationId}/`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': csrfToken
                }
            });
            
            if (!response.ok) {
                throw new Error(`Server returned ${response.status}`);
            }
            
            // Remove from DOM
            const conversationItem = document.querySelector(`.conversation-item[data-id="${conversationId}"]`);
            if (conversationItem) {
                conversationItem.remove();
            }
            
            // If this was the active conversation, clear the chat
            if (currentConversationId === conversationId) {
                currentConversationId = null;
                clearChatMessages();
                chatInput.focus();
                
                // Clear URL parameter
                const url = new URL(window.location);
                url.searchParams.delete('conversation_id');
                window.history.pushState({}, '', url);
            }
            
            // Refresh conversation list
            loadConversations();
            
        } catch (error) {
            console.error('Error deleting conversation:', error);
            alert('Failed to delete conversation. Please try again.');
        }
    }

    // Helper function to format timestamps
    function formatTimestamp(date) {
        const now = new Date();
        const diff = now - date;
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const days = Math.floor(hours / 24);
        
        if (hours < 1) return 'Just now';
        if (hours < 24) return `${hours}h ago`;
        if (days < 7) return `${days}d ago`;
        
        // Format as date for older conversations
        const options = { month: 'short', day: 'numeric' };
        if (date.getFullYear() !== now.getFullYear()) {
            options.year = 'numeric';
        }
        return date.toLocaleDateString('en-US', options);
    }
    
    // Modify the function that creates conversation items to be even more compact
    function createCompactConversationItem(conversation) {
        const conversationItem = document.createElement('div');
        conversationItem.className = 'conversation-item';
        conversationItem.dataset.id = conversation.id;
        
        // Truncate title to be compact
        let title = conversation.title || `Chat ${conversation.id}`;
        if (title.length > 25) { // Allow slightly longer titles
            title = title.substring(0, 25) + '...';
        }
        
        // Format timestamp
        const timestamp = conversation.created_at ? new Date(conversation.created_at) : new Date();
        const timeStr = formatTimestamp(timestamp);
        
        // A teammate's chat (only ever listed when the project shares chat history)
        // is labelled with its author and is read-only — no delete button, since
        // only the author may delete their own conversation.
        const isMine = conversation.is_mine !== false;
        const author = conversation.author;

        const esc = (v) => String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');

        // Pin + delete, matching the rail on every other page — the same list should
        // not be a different component depending on which page you're standing on.
        const pinned = !!conversation.pinned;
        if (pinned) conversationItem.classList.add('is-pinned');
        conversationItem.innerHTML = `
            <div class="conversation-title" title="${esc(conversation.title)}${isMine ? '' : ' — ' + esc(author)}">${esc(title)}</div>
            ${isMine
                ? '<button class="conversation-pin" title="' + (pinned ? 'Unpin' : 'Pin to top') + '" data-pin="' + esc(conversation.id) + '" data-pinned="' + (pinned ? '1' : '') + '"><i class="fas fa-thumbtack"></i></button>'
                  + '<button class="delete-conversation" title="Delete"><i class="fas fa-trash"></i></button>'
                : '<span class="conversation-author" title="' + esc(author) + "'s chat (read-only)\">" + esc(author) + '</span>'}
        `;
        const pinBtn = conversationItem.querySelector('[data-pin]');
        if (pinBtn) {
            pinBtn.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();   // must not also open the chat
                pinBtn.disabled = true;
                fetch('/api/conversations/' + conversation.id + '/pin', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pinned: !pinned }),
                }).then((r) => r.json())
                  .then((j) => { if (j && j.ok) loadConversations(); else pinBtn.disabled = false; })
                  .catch(() => { pinBtn.disabled = false; });
            });
        }
        if (!isMine) conversationItem.classList.add('conversation-shared');

        return conversationItem;
    }

    // Add a test function to simulate a notification for debugging purposes
    window.testNotification = function(type) {
        console.log('Manually triggering notification test...');
        const notificationType = type || 'features';
        
        // Create a fake notification data object
        const fakeNotificationData = {
            type: 'ai_chunk',
            chunk: '',
            is_final: false,
            is_notification: true,
            notification_type: notificationType
        };
        
        // Process it through the normal handler
        console.log('Simulating notification with data:', fakeNotificationData);
        handleAIChunk(fakeNotificationData);
    };

    // Add a test function to simulate function call indicators for debugging
    window.testFunctionCall = function(functionName) {
        console.log('Testing function call indicator for:', functionName);
        
        const validFunctions = ['extract_features', 'extract_personas', 'get_features', 'get_personas', 'execute_command', 'start_server', 'save_implementation'];
        const fn = validFunctions.includes(functionName) ? functionName : validFunctions[0];
        
        // Add a simulated assistant message first
        if (!getLastAssistantMessage()) {
            addMessageToChat('assistant', `I'll extract the key information from our conversation. Let me call the ${fn} function to process this data.`);
        }
        
        // Add the separator that would normally appear right after the function mention
        const separator = document.createElement('div');
        separator.className = 'function-call-separator';
        separator.innerHTML = `<div class="separator-line"></div>
                              <div class="separator-text">Calling function: ${fn}</div>
                              <div class="separator-line"></div>`;
        messageContainer.appendChild(separator);
        
        // Show the function call indicator
        showFunctionCallIndicator(fn);
        
        // After a delay, show the success message
        setTimeout(() => {
            const type = fn.includes('features') ? 'features' : 'personas';
            
            // Add a simulated response message
            setTimeout(() => {
                if (fn === 'extract_features') {
                    addMessageToChat('assistant', 'I\'ve successfully extracted and saved the features. You can view them in the artifacts panel.');
                } else if (fn === 'extract_personas') {
                    addMessageToChat('assistant', 'I\'ve successfully identified and saved the personas. You can view them in the artifacts panel.');
                } else {
                    addMessageToChat('assistant', 'I\'ve successfully retrieved the data. You can view it in the artifacts panel.');
                }
            }, 1000);
        }, 3000);
    };

    // Add a helper function to force open the artifacts panel
    window.forceOpenArtifactsPanel = function(tabType) {
        console.log('Force opening artifacts panel with tab:', tabType);
        
        // First try using the API if available
        if (window.ArtifactsPanel && typeof window.ArtifactsPanel.toggle === 'function') {
            window.ArtifactsPanel.toggle(true);
        }
        
        // Then try direct DOM manipulation
        const panel = document.getElementById('artifacts-panel');
        const appContainer = document.querySelector('.app-container');
        const button = document.getElementById('artifacts-button');
        
        if (panel && appContainer) {
            panel.classList.add('expanded');
            appContainer.classList.add('artifacts-expanded');
            if (button) button.classList.add('active');
        }
        
        // Then try to switch to the correct tab
        if (window.switchTab && tabType) {
            setTimeout(() => {
                window.switchTab(tabType);
                
                // Try to load the content based on the tab type
                if (window.ArtifactsLoader) {
                    const projectId = currentProjectId || extractProjectIdFromPath();
                    
                    if (projectId) {
                        if (tabType === 'features' && typeof window.ArtifactsLoader.loadFeatures === 'function') {
                            window.ArtifactsLoader.loadFeatures(projectId);
                        } else if (tabType === 'personas' && typeof window.ArtifactsLoader.loadPersonas === 'function') {
                            window.ArtifactsLoader.loadPersonas(projectId);
                        } else if (tabType === 'prd' && typeof window.ArtifactsLoader.loadFileBrowser === 'function') {
                            // Load file browser for PRD
                            window.ArtifactsLoader.loadFileBrowser(projectId);
                        } else if (tabType === 'implementation' && typeof window.ArtifactsLoader.loadFileBrowser === 'function') {
                            // Load file browser for Implementation
                            window.ArtifactsLoader.loadFileBrowser(projectId);
                        }
                    }
                }
            }, 100); // Small delay to ensure panel is open first
        }
    };

    /**
     * Test function to demonstrate notification styles
     * This can be called from the console with: testNotifications()
     */
    function testNotifications() {
        console.log('Testing notification indicators');
        
        // Test default function call indicator
        showFunctionCallIndicator('test_function');
        
        // Test function call for features
        setTimeout(() => {
            const featuresElement = document.createElement('div');
            featuresElement.className = 'function-features';
            document.querySelector('.messages').appendChild(featuresElement);
            
            showFunctionCallIndicator('extract_features', 'features');
        }, 1000);
        
        // Test function call for personas
        setTimeout(() => {
            const personasElement = document.createElement('div');
            personasElement.className = 'function-personas';
            document.querySelector('.messages').appendChild(personasElement);
            
            showFunctionCallIndicator('extract_personas', 'personas');
        }, 2000);
        
        // Test success notification
        setTimeout(() => {
            showFunctionCallSuccess('test_function');
        }, 3000);
        
        // Test success notification for features
        setTimeout(() => {
            showFunctionCallSuccess('extract_features', 'features');
        }, 4000);
        
        // Test success notification for personas
        setTimeout(() => {
            showFunctionCallSuccess('extract_personas', 'personas');
        }, 5000);
        
        // Test mini indicators
        setTimeout(() => {
            addFunctionCallMiniIndicator('test_function');
        }, 6000);
        
        setTimeout(() => {
            addFunctionCallMiniIndicator('extract_features', 'features');
        }, 6500);
        
        setTimeout(() => {
            addFunctionCallMiniIndicator('extract_personas', 'personas');
        }, 7000);
        
        console.log('All notification tests queued');
    }

    // Expose the test function globally
    window.testNotifications = testNotifications;

    // Function to load message files
    async function loadMessageFiles(conversationId) {
        try {
            const response = await fetch(`/api/conversations/${conversationId}/files/`);
            const files = await response.json();
            
            // Clear existing message files
            const messageFilesContainer = document.getElementById('message-files');
            if (!messageFilesContainer) {
                console.warn('[Chat] message-files container not found');
                return;
            }
            messageFilesContainer.innerHTML = '';
            
            // Add message files to the container
            files.forEach(file => {
                const fileItem = document.createElement('div');
                fileItem.className = 'message-file';
                fileItem.textContent = file.name;
                
                // Add click handler to download the file
                fileItem.addEventListener('click', () => {
                    downloadFile(file.url);
                });
                
                messageFilesContainer.appendChild(fileItem);
            });
        } catch (error) {
            console.error('Error loading message files:', error);
        }
    }

    // Function to download a file
    function downloadFile(fileUrl) {
        // Implement the logic to download the file from the given URL
        console.log('Downloading file:', fileUrl);
    }

    // Add a function to test the file upload API directly for debugging
    window.testFileUpload = async function(conversationId) {
        // Create a simple test file
        const blob = new Blob(['Test file content'], { type: 'text/plain' });
        const file = new File([blob], 'test-upload.txt', { type: 'text/plain' });
        
        console.log('Starting test upload with file:', file);
        console.log('Using conversation ID:', conversationId);
        
        try {
            const result = await uploadFileToServer(file, conversationId);
            console.log('Test upload successful:', result);
            alert(`Test upload successful! File ID: ${result.id}`);
            return result;
        } catch (error) {
            console.error('Test upload failed:', error);
            alert(`Test upload failed: ${error.message}`);
        }
    };
    
    // Function to load agent settings including turbo mode
    async function loadAgentSettings() {
        try {
            const response = await fetch('/accounts/agent-settings', {
                method: 'GET',
                headers: {
                    'X-CSRFToken': getCsrfToken(),
                }
            });
            
            if (response.ok) {
                const data = await response.json();
                if (data.success) {
                    // Set turbo mode toggle state
                    const turboModeToggle = document.getElementById('turbo-mode-toggle');
                    if (turboModeToggle) {
                        turboModeToggle.checked = data.turbo_mode;
                        console.log('Turbo mode loaded:', data.turbo_mode);
                        
                        // Update role dropdown visibility based on turbo mode
                        updateRoleDropdownVisibility(data.turbo_mode);
                        updateArtifactsForInstantMode(data.turbo_mode);
                    }
                    
                    // Set role dropdown value if not in turbo mode
                    if (!data.turbo_mode && data.agent_role) {
                        if (typeof setCustomDropdownValue === 'function') {
                            setCustomDropdownValue('role-dropdown', data.agent_role);
                        } else {
                            // Fallback for old select dropdown
                            const roleDropdown = document.getElementById('role-dropdown');
                            if (roleDropdown && roleDropdown.tagName === 'SELECT') {
                                roleDropdown.value = data.agent_role;
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Error loading agent settings:', error);
        }
    }
    
    // Function to update role dropdown visibility based on turbo mode
    function updateRoleDropdownVisibility(turboModeEnabled) {
        // For custom dropdown wrapper
        const roleDropdownWrapper = document.getElementById('role-dropdown-wrapper');
        if (roleDropdownWrapper) {
            roleDropdownWrapper.style.display = turboModeEnabled ? 'none' : 'block';
        } else {
            // Fallback for old select dropdown
            const roleDropdown = document.getElementById('role-dropdown');
            if (roleDropdown) {
                roleDropdown.style.display = turboModeEnabled ? 'none' : 'block';
            }
        }
    }
    
    // Add event listener for turbo mode toggle
    const turboModeToggle = document.getElementById('turbo-mode-toggle');
    if (turboModeToggle) {
        turboModeToggle.addEventListener('change', function() {
            const isEnabled = this.checked;
            console.log('Turbo mode toggled:', isEnabled);
            
            // Update role dropdown visibility
            updateRoleDropdownVisibility(isEnabled);
            updateArtifactsForInstantMode(isEnabled);
        });
    }
    updateArtifactsForInstantMode(isInstantModeEnabled());
    
    // Helper function to create recording indicator
    function createRecordingIndicator() {
        const indicator = document.createElement('div');
        indicator.className = 'audio-recording-indicator';
        
        // Create top row with waveform and controls
        const topRow = document.createElement('div');
        topRow.style.cssText = 'display: flex; align-items: center; gap: 8px; width: 100%;';
        
        // Create waveform
        const waveform = document.createElement('div');
        waveform.className = 'audio-waveform';
        
        // Add 20 bars for the waveform
        for (let i = 0; i < 20; i++) {
            const bar = document.createElement('div');
            bar.className = 'waveform-bar';
            bar.style.height = '4px'; // Set smaller initial height
            waveform.appendChild(bar);
        }
        
        // Create time display
        const timeDisplay = document.createElement('div');
        timeDisplay.className = 'recording-time';
        timeDisplay.textContent = '00:00';
        
        // Create cancel button
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'recording-cancel-btn';
        cancelBtn.innerHTML = '<i class="fas fa-times"></i>';
        cancelBtn.title = 'Cancel recording';
        cancelBtn.onclick = () => {
            // Stop recording without saving
            if (mediaRecorder && mediaRecorder.state === 'recording') {
                // Set flag to indicate cancellation
                window.recordingCancelled = true;
                mediaRecorder.stop();
            }
        };
        
        topRow.appendChild(waveform);
        topRow.appendChild(timeDisplay);
        topRow.appendChild(cancelBtn);
        
        // Create transcription row
        const transcriptionRow = document.createElement('div');
        transcriptionRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-top: 12px;';
        
        // Create transcription area
        const transcriptionArea = document.createElement('div');
        transcriptionArea.className = 'live-transcription';
        transcriptionArea.style.cssText = 'flex: 1; padding: 8px 12px; background: rgba(255,255,255,0.05); border-radius: 6px; min-height: 40px; color: #e2e8f0; font-size: 14px; line-height: 1.4;';
        transcriptionArea.innerHTML = '<span style="color: #94a3b8; font-style: italic;">Listening...</span>';
        
        // Create send button (initially hidden)
        const sendBtn = document.createElement('button');
        sendBtn.className = 'recording-send-btn';
        sendBtn.style.cssText = 'width: 36px; height: 36px; padding: 0; background: #3b82f6; color: white; border: none; border-radius: 50%; font-size: 14px; cursor: pointer; display: none; align-self: center; flex-shrink: 0;';
        sendBtn.innerHTML = '<i class="fas fa-paper-plane"></i>';
        sendBtn.title = 'Send message';
        sendBtn.onclick = () => {
            if (mediaRecorder && mediaRecorder.state === 'recording') {
                mediaRecorder.stop();
            }
        };
        
        transcriptionRow.appendChild(transcriptionArea);
        transcriptionRow.appendChild(sendBtn);
        
        indicator.appendChild(topRow);
        indicator.appendChild(transcriptionRow);
        
        // Store references for easy access
        indicator.transcriptionArea = transcriptionArea;
        indicator.sendBtn = sendBtn;
        
        return indicator;
    }
    
    // Helper function to send audio message
    async function sendAudioMessage(audioFile, liveTranscript = '') {
        // Add user message with audio indicator
        const audioIndicator = document.createElement('div');
        audioIndicator.className = 'message-audio';
        audioIndicator.innerHTML = `
            <div class="message-audio-container">
                <div class="message-audio-header">
                    <i class="fas fa-microphone" style="font-size: 14px;"></i>
                    Voice message
                </div>
                ${liveTranscript ? `
                    <div class="audio-transcription">
                        ${liveTranscript}
                    </div>
                ` : `
                    <div class="audio-transcription" style="display: none;">
                        Transcribing...
                    </div>
                `}
            </div>
        `;
        
        // If we have a live transcript, send it as a message with audio styling
        if (liveTranscript && liveTranscript.trim()) {
            const messageElement = addMessageToChat('user', '', { 
                audioIndicator: audioIndicator
            });
            
            // Send the transcribed text to the server
            sendMessageToServer(liveTranscript);
            return;
        }
        
        // Otherwise, proceed with file upload
        const messageElement = addMessageToChat('user', '', { 
            audioIndicator: audioIndicator,
            file: audioFile 
        });
        
        // Store reference to update transcription later
        if (messageElement) {
            window.lastAudioMessageElement = messageElement;
        }
        
        // Upload audio file
        const formData = new FormData();
        formData.append('file', audioFile);
        formData.append('conversation_id', currentConversationId || '');
        
        try {
            const response = await fetch('/api/files/upload/', {
                method: 'POST',
                headers: {
                    'X-CSRFToken': getCookie('csrftoken'),
                    'X-Requested-With': 'XMLHttpRequest'
                },
                body: formData
            });
            
            if (!response.ok) {
                throw new Error('Failed to upload audio file');
            }
            
            const fileData = await response.json();
            console.log('Audio file uploaded:', fileData);
            
            // Show transcription loading state
            if (window.lastAudioMessageElement) {
                const transcriptionDiv = window.lastAudioMessageElement.querySelector('.audio-transcription');
                if (transcriptionDiv) {
                    transcriptionDiv.style.display = 'block';
                }
            }
            
            // Get transcription from the API
            let transcription = null;
            try {
                console.log('Fetching transcription for file:', fileData.id);
                const transcriptionResponse = await fetch(`/api/files/transcribe/${fileData.id}/`, {
                    method: 'GET',
                    headers: {
                        'X-CSRFToken': getCookie('csrftoken'),
                        'X-Requested-With': 'XMLHttpRequest'
                    }
                });
                
                console.log('Transcription response status:', transcriptionResponse.status);
                
                if (transcriptionResponse.ok) {
                    const transcriptionData = await transcriptionResponse.json();
                    console.log('Transcription received:', transcriptionData);
                    transcription = transcriptionData.transcription;
                    
                    // Update the audio message with transcription
                    if (window.lastAudioMessageElement) {
                        const transcriptionDiv = window.lastAudioMessageElement.querySelector('.audio-transcription');
                        console.log('Found transcription div:', transcriptionDiv);
                        if (transcriptionDiv && transcription) {
                            transcriptionDiv.innerHTML = transcription;
                            transcriptionDiv.style.display = 'block';
                            console.log('Updated transcription display with:', transcription);
                        }
                    } else {
                        console.log('No lastAudioMessageElement found');
                    }
                } else {
                    const errorData = await transcriptionResponse.text();
                    console.error('Transcription failed:', transcriptionResponse.status, errorData);
                    // Show error in UI
                    if (window.lastAudioMessageElement) {
                        const transcriptionDiv = window.lastAudioMessageElement.querySelector('.audio-transcription');
                        if (transcriptionDiv) {
                            transcriptionDiv.textContent = 'Transcription failed';
                            transcriptionDiv.style.display = 'block';
                            transcriptionDiv.style.color = '#ef4444';
                        }
                    }
                }
            } catch (error) {
                console.error('Error getting transcription:', error);
                // Show error in UI
                if (window.lastAudioMessageElement) {
                    const transcriptionDiv = window.lastAudioMessageElement.querySelector('.audio-transcription');
                    if (transcriptionDiv) {
                        transcriptionDiv.textContent = 'Transcription error';
                        transcriptionDiv.style.display = 'block';
                        transcriptionDiv.style.color = '#ef4444';
                    }
                }
            }
            
            // Send message via WebSocket with audio file reference
            if (socket && isSocketConnected) {
                // Use transcription as message content if available
                const messageContent = transcription || '[Voice Message]';
                
                const messageData = {
                    type: 'message',
                    message: messageContent,
                    conversation_id: currentConversationId,
                    project_id: currentProjectId,
                    file: {
                        id: fileData.id,
                        name: audioFile.name,
                        type: audioFile.type,
                        size: audioFile.size
                    },
                    user_role: getCurrentUserRole(),
                    turbo_mode: document.getElementById('turbo-mode-toggle')?.checked || false
                };
                
                socket.send(JSON.stringify(messageData));
            }
            
        } catch (error) {
            console.error('Error sending audio message:', error);
            alert('Failed to send audio message');
        }
    }
    
    // Helper function to format file size
    function formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        else if (bytes < 1048576) return Math.round(bytes / 1024) + ' KB';
        else return Math.round(bytes / 1048576) + ' MB';
    }
    
    // Helper function to extract audio transcription from AI response
    function extractAudioTranscription(content) {
        // Match pattern: [Audio Transcription of filename]: transcribed text
        // Look for the transcription pattern and capture everything after it
        const match = content.match(/\[Audio Transcription of [^\]]+\]:\s*\n*(.+?)$/s);
        if (match && match[1]) {
            // Extract just the transcribed text, stopping at the next paragraph or end
            const transcribedText = match[1].split(/\n\n/)[0].trim();
            console.log('Extracted transcription:', transcribedText);
            return transcribedText;
        }
        console.log('No transcription found in:', content);
        return null;
    }
    
    // Helper function to get current user role
    function getCurrentUserRole() {
        const roleDropdown = document.querySelector('#role-dropdown-wrapper .custom-dropdown-item.selected');
        return roleDropdown ? roleDropdown.dataset.value : 'product_analyst';
    }
    
    // @ Mention Helper Functions
    // Create + position the shared dropdown element near the input.
    function ensureMentionDropdown() {
        if (!mentionDropdown) {
            mentionDropdown = document.createElement('div');
            mentionDropdown.className = 'mention-dropdown';
            mentionDropdown.style.cssText = `
                position: absolute;
                background: var(--card-bg, #1a1a1a);
                border: 1px solid var(--border-color, #333);
                border-radius: 10px;
                box-shadow: 0 8px 28px rgba(16,24,40,0.18);
                max-height: 220px;
                overflow: hidden auto;
                z-index: 1000;
                min-width: 260px;
                padding: 4px;
            `;
            document.body.appendChild(mentionDropdown);
        }
        const inputRect = chatInput.getBoundingClientRect();
        mentionDropdown.style.left = inputRect.left + 'px';
        mentionDropdown.style.bottom = (window.innerHeight - inputRect.top + 5) + 'px';
    }

    function showMentionDropdown(searchQuery) {
        ensureMentionDropdown();
        fetchMentionFiles(searchQuery);
    }

    // @ticket picker — fetch tickets and render.
    function showTicketDropdown(searchQuery) {
        ensureMentionDropdown();
        fetchMentionTickets(searchQuery);
    }

    async function fetchMentionTickets(searchQuery) {
        if (!currentProjectId) return;
        try {
            const url = `/api/projects/${currentProjectId}/ticket-mentions?q=${encodeURIComponent(searchQuery || '')}`;
            const response = await fetch(url, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const data = await response.json();
            mentionTickets = data.tickets || [];
            selectedMentionIndex = 0;
            renderMentionList(mentionTickets, function(t){
                return '<div style="font-weight:500;color:var(--text-color,#e0e0e0);">' + escapeHtmlSafe(t.label) + '</div>'
                    + '<div style="font-size:12px;color:var(--text-secondary,#999);">' + escapeHtmlSafe(t.branch) + ' • ' + escapeHtmlSafe(t.status || '') + '</div>';
            });
        } catch (error) {
            console.error('Error fetching mention tickets:', error);
            hideMentionDropdown();
        }
    }

    // Top-level @ menu: Files / Ticket / Preview (filtered by the typed partial).
    function showAtMenu(partial) {
        ensureMentionDropdown();
        const all = [
            { key: 'file',    icon: '📄', title: 'Files',   desc: 'Reference a project file' },
            { key: 'ticket',  icon: '🎫', title: 'Ticket',  desc: 'Ask about a ticket (loads its branch)' },
            { key: 'preview', icon: '🖥', title: 'Preview', desc: 'Control the live preview (@preview)' },
        ];
        mentionMenuItems = all.filter(function(m){ return m.key.indexOf(partial || '') === 0 || (partial || '') === ''; });
        if (!mentionMenuItems.length) { hideMentionDropdown(); return; }
        selectedMentionIndex = 0;
        renderMentionList(mentionMenuItems, function(m){
            return '<div style="font-weight:500;color:var(--text-color,#e0e0e0);">' + m.icon + ' ' + m.title + '</div>'
                + '<div style="font-size:12px;color:var(--text-secondary,#999);">' + m.desc + '</div>';
        });
    }

    // Generic renderer used by ticket + menu modes (files keep updateMentionDropdown).
    function renderMentionList(items, itemHtml) {
        if (!mentionDropdown || !items.length) { hideMentionDropdown(); return; }
        mentionDropdown.innerHTML = '';
        items.forEach(function(it, index){
            const el = document.createElement('div');
            el.className = 'mention-item';
            el.style.cssText = 'padding:8px 10px;cursor:pointer;border-radius:7px;' + (index === selectedMentionIndex ? 'background-color:rgba(124,58,237,0.14);' : '');
            el.innerHTML = itemHtml(it);
            el.addEventListener('click', function(){ selectActiveMention(it); });
            el.addEventListener('mouseenter', function(){ selectedMentionIndex = index; updateMentionSelection(); });
            mentionDropdown.appendChild(el);
        });
        mentionDropdown.style.display = 'block';
    }

    function escapeHtmlSafe(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; });
    }

    // Selecting a top-level menu item → replace the partial with the real trigger.
    function selectMentionMenu(item) {
        const cursorPosition = chatInput.selectionStart;
        const before = chatInput.value.substring(0, mentionStartIndex);
        const after = chatInput.value.substring(cursorPosition);
        const trigger = item.key === 'file' ? '@file' : item.key === 'ticket' ? '@ticket' : '@preview ';
        chatInput.value = before + trigger + after;
        const pos = before.length + trigger.length;
        chatInput.setSelectionRange(pos, pos);
        hideMentionDropdown();
        chatInput.focus();
        chatInput.dispatchEvent(new Event('input')); // re-trigger → opens file/ticket picker
    }

    // Selecting a ticket → insert a token + stash it for the send payload.
    function selectMentionTicket(t) {
        if (!t) return;
        const cursorPosition = chatInput.selectionStart;
        const before = chatInput.value.substring(0, mentionStartIndex);
        const after = chatInput.value.substring(cursorPosition);
        const token = '@ticket:' + (t.ticketKey || t.id);
        chatInput.value = before + token + ' ' + after;
        const pos = before.length + token.length + 1;
        chatInput.setSelectionRange(pos, pos);
        if (!window.mentionedTickets) window.mentionedTickets = {};
        window.mentionedTickets[t.ticketKey || t.id] = { id: t.id, key: t.ticketKey || '', name: t.name, branch: t.branch };
        hideMentionDropdown();
        chatInput.focus();
        chatInput.dispatchEvent(new Event('input'));
    }
    
    function hideMentionDropdown() {
        if (mentionDropdown) {
            mentionDropdown.style.display = 'none';
            mentionFiles = [];
            mentionTickets = [];
            mentionMenuItems = [];
            selectedMentionIndex = 0;
        }
    }
    
    async function fetchMentionFiles(searchQuery) {
        if (!currentProjectId) {
            console.error('No project ID available for fetching files');
            return;
        }
        
        try {
            const url = `/projects/${currentProjectId}/api/files/mentions/?q=${encodeURIComponent(searchQuery)}`;
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'X-Requested-With': 'XMLHttpRequest'
                }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            mentionFiles = data.files || [];
            selectedMentionIndex = 0;
            
            // Update dropdown content
            updateMentionDropdown();
            
        } catch (error) {
            console.error('Error fetching mention files:', error);
            hideMentionDropdown();
        }
    }
    
    function updateMentionDropdown() {
        if (!mentionDropdown || mentionFiles.length === 0) {
            hideMentionDropdown();
            return;
        }
        
        // Clear existing content
        mentionDropdown.innerHTML = '';
        
        // Add files to dropdown
        mentionFiles.forEach((file, index) => {
            const item = document.createElement('div');
            item.className = 'mention-item';
            item.style.cssText = `
                padding: 8px 10px;
                cursor: pointer;
                border-radius: 7px;
                ${index === selectedMentionIndex ? 'background-color: rgba(124,58,237,0.14);' : ''}
            `;

            item.innerHTML = `
                <div style="font-weight: 500; color: var(--text-color, #e0e0e0);">${file.name}</div>
                <div style="font-size: 12px; color: var(--text-secondary, #999);">${file.type} • Updated ${file.updated_at}</div>
            `;
            
            item.addEventListener('click', () => selectMentionFile(file));
            item.addEventListener('mouseenter', () => {
                selectedMentionIndex = index;
                updateMentionSelection();
            });
            
            mentionDropdown.appendChild(item);
        });
        
        // Show the dropdown
        mentionDropdown.style.display = 'block';
    }
    
    function updateMentionSelection() {
        const items = mentionDropdown.querySelectorAll('.mention-item');
        items.forEach((item, index) => {
            if (index === selectedMentionIndex) {
                item.style.backgroundColor = 'rgba(124,58,237,0.14)';
            } else {
                item.style.backgroundColor = '';
            }
        });
    }
    
    async function selectMentionFile(file) {
        if (!file) return;
        
        try {
            // Get the file content
            const url = `/projects/${currentProjectId}/api/files/${file.id}/content`;
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'X-Requested-With': 'XMLHttpRequest'
                }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const fileData = await response.json();
            
            // Remove the @mention from the input
            const cursorPosition = chatInput.selectionStart;
            const textBeforeMention = chatInput.value.substring(0, mentionStartIndex);
            const textAfterCursor = chatInput.value.substring(cursorPosition);
            
            // Add a reference to the file in the message
            const fileReference = `[@${file.name}](file:${file.id})`;
            
            // Update the input value with the file reference
            chatInput.value = textBeforeMention + fileReference + ' ' + textAfterCursor;
            
            // Set cursor position after the reference
            const newCursorPosition = textBeforeMention.length + fileReference.length + 1;
            chatInput.setSelectionRange(newCursorPosition, newCursorPosition);
            
            // Store the file content in a hidden data structure that will be sent with the message
            if (!window.mentionedFiles) {
                window.mentionedFiles = {};
            }
            window.mentionedFiles[file.id] = {
                id: file.id,
                name: file.name,
                type: file.type,
                content: fileData.content
            };
            
            console.log('Mentioned file stored:', file.name);
            
            // Trigger input event to resize textarea
            chatInput.dispatchEvent(new Event('input'));
            
            // Hide the dropdown
            hideMentionDropdown();
            
            // Focus back on the input
            chatInput.focus();
            
        } catch (error) {
            console.error('Error fetching file content:', error);
            alert('Failed to fetch file content');
        }
    }
    
    // Add styles for mention dropdown
    const mentionStyles = document.createElement('style');
    mentionStyles.textContent = `
        .mention-dropdown {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        
        .mention-item:hover {
            background-color: #f0f0f0;
        }
        
        .mention-item:last-child {
            border-bottom: none;
        }
    `;
    document.head.appendChild(mentionStyles);
    
    // Function to show token exhausted popup dynamically
    function showTokenExhaustedPopup() {
        // Check if popup already exists
        if (document.getElementById('dynamic-tokens-exhausted-popup')) {
            return;
        }
        
        // Get user tier info from window or default values
        const isFreeTier = window.isFreeTier !== undefined ? window.isFreeTier : true;
        
        const popup = document.createElement('div');
        popup.id = 'dynamic-tokens-exhausted-popup';
        popup.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.8); display: flex; align-items: center; justify-content: center; z-index: 10000;';
        
        popup.innerHTML = `
            <div style="background: #1f2937; border-radius: 12px; padding: 2rem; max-width: 500px; width: 90%; border: 1px solid #374151; position: relative;">
                <button onclick="document.getElementById('dynamic-tokens-exhausted-popup').remove()" style="position: absolute; top: 1rem; right: 1rem; background: none; border: none; color: #9ca3af; font-size: 1.5rem; cursor: pointer;">
                    <i class="fas fa-times"></i>
                </button>
                
                <div style="text-align: center; margin-bottom: 1.5rem;">
                    <i class="fas fa-exclamation-triangle" style="font-size: 3rem; color: #f59e0b; margin-bottom: 1rem; display: block;"></i>
                    <h2 style="color: #f3f4f6; font-size: 1.5rem; margin-bottom: 0.5rem;">Token Limit Reached</h2>
                    <p style="color: #9ca3af;">You've used all your available tokens</p>
                </div>
                
                ${isFreeTier ? `
                <div style="background: #111827; padding: 1rem; border-radius: 8px; margin-bottom: 1.5rem;">
                    <p style="color: #f3f4f6; margin-bottom: 0.5rem;">You've used your 100,000 free tokens.</p>
                    <p style="color: #9ca3af;">Upgrade to Pro to continue building with AI.</p>
                </div>
                
                <div style="background: linear-gradient(135deg, #9333ea 0%, #7c3aed 100%); padding: 1rem; border-radius: 8px; margin-bottom: 1rem;">
                    <h3 style="color: #ffffff; font-size: 1rem; margin-bottom: 0.5rem;">Pro Plan - $9/month</h3>
                    <ul style="color: #e9d5ff; list-style: none; padding: 0; margin: 0;">
                        <li style="margin-bottom: 0.25rem;"><i class="fas fa-check" style="margin-right: 0.5rem;"></i> 300,000 tokens per month</li>
                        <li style="margin-bottom: 0.25rem;"><i class="fas fa-check" style="margin-right: 0.5rem;"></i> Access to all AI models</li>
                        <li><i class="fas fa-check" style="margin-right: 0.5rem;"></i> Monthly token reset</li>
                    </ul>
                </div>
                ` : `
                <div style="background: #111827; padding: 1rem; border-radius: 8px; margin-bottom: 1.5rem;">
                    <p style="color: #f3f4f6; margin-bottom: 0.5rem;">You've used your monthly quota of 300,000 tokens.</p>
                    <p style="color: #9ca3af;">Purchase additional tokens or wait for your monthly reset.</p>
                </div>
                `}
                
                <div style="display: flex; gap: 1rem;">
                    <button onclick="document.getElementById('dynamic-tokens-exhausted-popup').remove()" style="flex: 1; background: #374151; color: #f3f4f6; border: none; padding: 0.75rem; border-radius: 8px; cursor: pointer; font-size: 1rem;">
                        Close
                    </button>
                    <a href="/subscriptions/" style="flex: 1; background: #10b981; color: white; border: none; padding: 0.75rem; border-radius: 8px; cursor: pointer; font-size: 1rem; text-align: center; text-decoration: none; display: block;">
                        ${isFreeTier ? 'Upgrade to Pro' : 'Buy More Tokens'}
                    </a>
                </div>
            </div>
        `;
        
        document.body.appendChild(popup);
    }
    
    // Make it available globally
    window.showTokenExhaustedPopup = showTokenExhaustedPopup;
});
