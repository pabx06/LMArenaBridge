// ==UserScript==
// @name         LMArena API Bridge
// @namespace    http://tampermonkey.net/
// @version      2.5
// @description  Bridges LMArena to a local API server via WebSocket for streamlined automation.
// @author       Lianues
// @match        https://lmarena.ai/*
// @match        https://*.lmarena.ai/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=lmarena.ai
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // --- Configuration ---
    const SERVER_URL = "ws://localhost:5102/ws"; // Matches the port in api_server.py
    let socket;
    let isCaptureModeActive = false; // Switch for ID capture mode

    // --- Core Logic ---
    function connect() {
        console.log(`[API Bridge] Connecting to local server: ${SERVER_URL}...`);
        socket = new WebSocket(SERVER_URL);

        socket.onopen = () => {
            console.log("[API Bridge] ✅ WebSocket connection to local server established.");
            document.title = "✅ " + document.title;
        };

        socket.onmessage = async (event) => {
            try {
                const message = JSON.parse(event.data);

                // Check if it's a command, not a standard chat request
                if (message.command) {
                    console.log(`[API Bridge] ⬇️ Received command: ${message.command}`);
                    if (message.command === 'refresh' || message.command === 'reconnect') {
                        console.log(`[API Bridge] Received '${message.command}' command, refreshing page...`);
                        location.reload();
                    } else if (message.command === 'activate_id_capture') {
                        console.log("[API Bridge] ✅ ID capture mode activated. Please trigger a 'Retry' action on the page.");
                        isCaptureModeActive = true;
                        // Optionally provide a visual cue to the user
                        document.title = "🎯 " + document.title;
                    }
                    return;
                }

                const { request_id, payload } = message;

                if (!request_id || !payload) {
                    console.error("[API Bridge] Received invalid message from server:", message);
                    return;
                }
                
                console.log(`[API Bridge] ⬇️ Received chat request ${request_id.substring(0, 8)}. Preparing to execute fetch.`);
                await executeFetchAndStreamBack(request_id, payload);

            } catch (error) {
                console.error("[API Bridge] Error processing message from server:", error);
            }
        };

        socket.onclose = () => {
            console.warn("[API Bridge] 🔌 Connection to local server lost. Attempting to reconnect in 5 seconds...");
            if (document.title.startsWith("✅ ")) {
                document.title = document.title.substring(2);
            }
            setTimeout(connect, 5000);
        };

        socket.onerror = (error) => {
            console.error("[API Bridge] ❌ WebSocket error occurred:", error);
            socket.close(); // This will trigger the reconnection logic in onclose
        };
    }

    async function executeFetchAndStreamBack(requestId, payload) {
        console.log(`[API Bridge] Current operating domain: ${window.location.hostname}`);
        const { is_image_request, message_templates, target_model_id, session_id, message_id } = payload;

        // --- Use session info passed from the backend ---
        if (!session_id || !message_id) {
            const errorMsg = "Session information (session_id or message_id) received from the backend is empty. Please run the `id_updater.py` script first to set it up.";
            console.error(`[API Bridge] ${errorMsg}`);
            sendToServer(requestId, { error: errorMsg });
            sendToServer(requestId, "[DONE]");
            return;
        }

        // The URL is the same for both chat and text-to-image generation
        const apiUrl = `/api/stream/retry-evaluation-session-message/${session_id}/messages/${message_id}`;
        const httpMethod = 'PUT';
        
        console.log(`[API Bridge] Using API endpoint: ${apiUrl}`);
        
        const newMessages = [];
        let lastMsgIdInChain = null;

        if (!message_templates || message_templates.length === 0) {
            const errorMsg = "Message list received from the backend is empty.";
            console.error(`[API Bridge] ${errorMsg}`);
            sendToServer(requestId, { error: errorMsg });
            sendToServer(requestId, "[DONE]");
            return;
        }

        // This loop logic is generic for both chat and text-to-image, as the backend prepares the correct message_templates
        for (let i = 0; i < message_templates.length; i++) {
            const template = message_templates[i];
            const currentMsgId = crypto.randomUUID();
            const parentIds = lastMsgIdInChain ? [lastMsgIdInChain] : [];
            
            // If it's a text-to-image request, the status is always 'success'
            // Otherwise, only the last message is 'pending'
            const status = is_image_request ? 'success' : ((i === message_templates.length - 1) ? 'pending' : 'success');

            newMessages.push({
                role: template.role,
                content: template.content,
                id: currentMsgId,
                evaluationId: null,
                evaluationSessionId: session_id,
                parentMessageIds: parentIds,
                experimental_attachments: template.attachments || [],
                failureReason: null,
                metadata: null,
                participantPosition: template.participantPosition || "a",
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                status: status,
            });
            lastMsgIdInChain = currentMsgId;
        }

        const body = {
            messages: newMessages,
            modelId: target_model_id,
        };

        console.log("[API Bridge] Final payload ready to be sent to LMArena API:", JSON.stringify(body, null, 2));

        // Set a flag to let our fetch interceptor know this request was initiated by the script itself
        window.isApiBridgeRequest = true;
        try {
            const response = await fetch(apiUrl, {
                method: httpMethod,
                headers: {
                    'Content-Type': 'text/plain;charset=UTF-8', // LMArena uses text/plain
                    'Accept': '*/*',
                },
                body: JSON.stringify(body),
                credentials: 'include' // Must include cookies
            });

            if (!response.ok || !response.body) {
                const errorBody = await response.text();
                throw new Error(`Network response was not ok. Status: ${response.status}. Body: ${errorBody}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { value, done } = await reader.read();
                if (done) {
                    console.log(`[API Bridge] ✅ Stream for request ${requestId.substring(0, 8)} has ended.`);
                    sendToServer(requestId, "[DONE]");
                    break;
                }
                const chunk = decoder.decode(value);
                // Directly forward the raw data chunk back to the backend
                sendToServer(requestId, chunk);
            }

        } catch (error) {
            console.error(`[API Bridge] ❌ Error executing fetch for request ${requestId.substring(0, 8)}:`, error);
            sendToServer(requestId, { error: error.message });
            sendToServer(requestId, "[DONE]");
        } finally {
            // Reset the flag after the request finishes, regardless of success or failure
            window.isApiBridgeRequest = false;
        }
    }

    function sendToServer(requestId, data) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            const message = {
                request_id: requestId,
                data: data
            };
            socket.send(JSON.stringify(message));
        } else {
            console.error("[API Bridge] Cannot send data, WebSocket connection is not open.");
        }
    }

    // --- Network Request Interception ---
    const originalFetch = window.fetch;
    window.fetch = function(...args) {
        const urlArg = args[0];
        let urlString = '';

        // Ensure we are always handling the URL as a string
        if (urlArg instanceof Request) {
            urlString = urlArg.url;
        } else if (urlArg instanceof URL) {
            urlString = urlArg.href;
        } else if (typeof urlArg === 'string') {
            urlString = urlArg;
        }

        // Only perform matching if the URL is a valid string
        if (urlString) {
            const match = urlString.match(/\/api\/stream\/retry-evaluation-session-message\/([a-f0-9-]+)\/messages\/([a-f0-9-]+)/);

            // Only update the ID if the request was NOT initiated by the API bridge itself AND capture mode is active
            if (match && !window.isApiBridgeRequest && isCaptureModeActive) {
                const sessionId = match[1];
                const messageId = match[2];
                console.log(`[API Bridge Interceptor] 🎯 Captured IDs in active mode! Sending...`);

                // Deactivate capture mode to ensure it only sends once
                isCaptureModeActive = false;
                if (document.title.startsWith("🎯 ")) {
                    document.title = document.title.substring(2);
                }

                // Asynchronously send the captured IDs to the local id_updater.py script
                fetch('http://127.0.0.1:5103/update', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId, messageId })
                })
                .then(response => {
                    if (!response.ok) throw new Error(`Server responded with status: ${response.status}`);
                    console.log(`[API Bridge] ✅ IDs sent for update successfully. Capture mode has been automatically disabled.`);
                })
                .catch(err => {
                    console.error('[API Bridge] Error sending ID update:', err.message);
                    // Even if sending fails, capture mode is already disabled and will not be retried.
                });
            }
        }

        // Call the original fetch function to ensure page functionality is not affected
        return originalFetch.apply(this, args);
    };


    // --- Send Page Source After Load ---
    function sendPageSourceAfterLoad() {
        const sendSource = async () => {
            console.log("[API Bridge] Page load complete. Sending page source for model list update...");
            try {
                const htmlContent = document.documentElement.outerHTML;
                await fetch('http://localhost:5102/update_models', { // URL matches the endpoint in api_server.py
                    method: 'POST',
                    headers: {
                        'Content-Type': 'text/html; charset=utf-8'
                    },
                    body: htmlContent
                });
                 console.log("[API Bridge] Page source sent successfully.");
            } catch (e) {
                console.error("[API Bridge] Failed to send page source:", e);
            }
        };

        if (document.readyState === 'complete') {
            sendSource();
        } else {
            window.addEventListener('load', sendSource);
        }
    }


    // --- Start Connection ---
    console.log("========================================");
    console.log("  LMArena API Bridge v2.1 is running.");
    console.log("  - Chat functionality connected to ws://localhost:5102");
    console.log("  - ID capturer will send to http://localhost:5103");
    console.log("========================================");
    
    sendPageSourceAfterLoad(); // Send page source
    connect(); // Establish WebSocket connection

})();
