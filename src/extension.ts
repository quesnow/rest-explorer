import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import fetch from 'node-fetch';

interface RequestHistory {
    url: string;
    method: string;
    timestamp: number;
    response: ResponseData;
}

interface WebviewMessage {
    command: string;
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    query?: Record<string, string>;
    auth?: {
        type: string;
        username?: string;
        password?: string;
        token?: string;
    };
}

interface ResponseData {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    size: number;
    time: number;
    cookies: Record<string, string>;
}

class RestExplorerViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'restExplorer.historyView';
    private _view?: vscode.WebviewView;
    private _history: RequestHistory[] = [];
    private _context: vscode.ExtensionContext;
    private _createNewRequestPanel: () => void;

    constructor(context: vscode.ExtensionContext, createNewRequestPanel: () => void) {
        this._context = context;
        this._createNewRequestPanel = createNewRequestPanel;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        token: vscode.CancellationToken
    ) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true
        };
        this._update();
        webviewView.webview.onDidReceiveMessage(
            (message: WebviewMessage) => {
                switch (message.command) {
                    case 'makeRequest':
                        if (message.url && message.method) {
                            this.makeRequest(message).then(response => {
                                const newHistory: RequestHistory = {
                                    url: message.url!,
                                    method: message.method!,
                                    timestamp: Date.now(),
                                    response: response
                                };
                                this._history.push(newHistory);
                                this._update();
                            });
                        }
                        break;
                    case 'openLink':
                        if (message.url) {
                            vscode.env.openExternal(vscode.Uri.parse(message.url));
                        }
                        break;
                    case 'startNewRequest':
                        this._createNewRequestPanel();
                        break;
                }
            },
            undefined,
            this._context.subscriptions
        );
    }

    private _update() {
        if (this._view) {
            this._view.webview.html = this.getWebviewContent(this._history);
        }
    }

    private async makeRequest(message: WebviewMessage): Promise<ResponseData> {
        let responseData: ResponseData;
        const startTime = Date.now();
        try {
            const url = new URL(message.url!);
            if (message.query) {
                Object.entries(message.query).forEach(([key, value]) => {
                    url.searchParams.append(key, value);
                });
            }
            const options: any = {
                method: message.method,
                headers: message.headers || {}
            };
            if (message.auth) {
                switch (message.auth.type) {
                    case 'basic':
                        const auth = Buffer.from(`${message.auth.username}:${message.auth.password}`).toString('base64');
                        options.headers['Authorization'] = `Basic ${auth}`;
                        break;
                    case 'bearer':
                        options.headers['Authorization'] = `Bearer ${message.auth.token}`;
                        break;
                }
            }
            if (['POST', 'PUT', 'PATCH'].includes(message.method!) && message.body) {
                options.body = message.body;
                if (!options.headers['Content-Type']) {
                    options.headers['Content-Type'] = 'application/json';
                }
            }
            // Accept self-signed certs for dev
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
            const response = await fetch(url.toString(), options);
            const text = await response.text();
            const endTime = Date.now();
            // Parse cookies from response headers
            const cookies: Record<string, string> = {};
            const setCookieHeader = response.headers.get('set-cookie');
            if (setCookieHeader) {
                setCookieHeader.split(';').forEach(cookie => {
                    const [name, value] = cookie.split('=');
                    if (name && value) {
                        cookies[name.trim()] = value.trim();
                    }
                });
            }
            // Convert headers to object
            const headers: Record<string, string> = {};
            response.headers.forEach((value, key) => {
                headers[key] = value;
            });
            responseData = {
                status: response.status,
                statusText: response.statusText,
                headers,
                body: text,
                size: text.length,
                time: endTime - startTime,
                cookies
            };
        } catch (error: unknown) {
            const endTime = Date.now();
            let errorMessage = 'An unknown error occurred';
            if (error instanceof Error) {
                errorMessage = error.message;
            } else if (typeof error === 'string') {
                errorMessage = error;
            }
            responseData = {
                status: 0,
                statusText: 'Error',
                headers: {},
                body: errorMessage,
                size: errorMessage.length,
                time: endTime - startTime,
                cookies: {}
            };
        }
        // Always send response to webview
        if (this._view) {
            this._view.webview.postMessage({
                command: 'response',
                data: responseData
            });
        }
        return responseData;
    }

    private getWebviewContent(history: RequestHistory[]): string {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    padding: 10px;
                    display: flex;
                    flex-direction: column;
                    height: 100vh;
                    margin: 0;
                    overflow: hidden;
                }
                .start-button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 10px 20px;
                    margin: 10px 0;
                    cursor: pointer;
                    width: 100%;
                    font-size: 14px;
                    border-radius: 4px;
                }
                .start-button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                .history-item {
                    border: 1px solid var(--vscode-panel-border);
                    margin: 10px 0;
                    padding: 10px;
                    border-radius: 4px;
                }
                .history-item:hover {
                    background-color: var(--vscode-list-hoverBackground);
                }
                .link {
                    color: var(--vscode-textLink-foreground);
                    text-decoration: underline;
                    cursor: pointer;
                }
                .response-panel {
                    height: 45%;
                    min-height: 200px;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                    border-top: 1px solid var(--vscode-panel-border);
                    background-color: var(--vscode-editor-background);
                    position: relative;
                }
                .resize-handle {
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    height: 4px;
                    cursor: ns-resize;
                    background-color: var(--vscode-panel-border);
                    user-select: none;
                    -webkit-user-select: none;
                }
                .resize-handle:hover {
                    background-color: var(--vscode-button-background);
                }
                .resize-handle.active {
                    background-color: var(--vscode-button-background);
                }
            </style>
        </head>
        <body>
            <button class="start-button" onclick="startNewRequest()">New Request</button>
            <div id="history">
                ${history.map(item => `
                    <div class="history-item">
                        <div><strong>${item.method}</strong> ${item.url}</div>
                        <div>${item.response.body.replace(
                            /(https?:\/\/[^\s]+)/g,
                            '<span class="link" onclick="openLink(\'$1\')">$1</span>'
                        )}</div>
                        <div><small>${new Date(item.timestamp).toLocaleString()}</small></div>
                    </div>
                `).join('')}
            </div>
            <script>
                const vscode = acquireVsCodeApi();

                function startNewRequest() {
                    vscode.postMessage({
                        command: 'startNewRequest'
                    });
                }

                function openLink(url) {
                    vscode.postMessage({
                        command: 'openLink',
                        url: url
                    });
                }
            </script>
        </body>
        </html>`;
    }
}

export function activate(context: vscode.ExtensionContext) {
    let currentPanels: vscode.WebviewPanel[] = [];

    // Move makeRequest function to the top level of activate
    async function makeRequest(message: WebviewMessage): Promise<ResponseData> {
        let responseData: ResponseData;
        const startTime = Date.now();
        try {
            const url = new URL(message.url!);
            if (message.query) {
                Object.entries(message.query).forEach(([key, value]) => {
                    url.searchParams.append(key, value);
                });
            }
            const options: any = {
                method: message.method,
                headers: message.headers || {}
            };
            if (message.auth) {
                switch (message.auth.type) {
                    case 'basic':
                        const auth = Buffer.from(`${message.auth.username}:${message.auth.password}`).toString('base64');
                        options.headers['Authorization'] = `Basic ${auth}`;
                        break;
                    case 'bearer':
                        options.headers['Authorization'] = `Bearer ${message.auth.token}`;
                        break;
                }
            }
            if (['POST', 'PUT', 'PATCH'].includes(message.method!) && message.body) {
                options.body = message.body;
                if (!options.headers['Content-Type']) {
                    options.headers['Content-Type'] = 'application/json';
                }
            }
            // Accept self-signed certs for dev
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
            const response = await fetch(url.toString(), options);
            const text = await response.text();
            const endTime = Date.now();
            // Parse cookies from response headers
            const cookies: Record<string, string> = {};
            const setCookieHeader = response.headers.get('set-cookie');
            if (setCookieHeader) {
                setCookieHeader.split(';').forEach(cookie => {
                    const [name, value] = cookie.split('=');
                    if (name && value) {
                        cookies[name.trim()] = value.trim();
                    }
                });
            }
            // Convert headers to object
            const headers: Record<string, string> = {};
            response.headers.forEach((value, key) => {
                headers[key] = value;
            });
            responseData = {
                status: response.status,
                statusText: response.statusText,
                headers,
                body: text,
                size: text.length,
                time: endTime - startTime,
                cookies
            };
        } catch (error: unknown) {
            const endTime = Date.now();
            let errorMessage = 'An unknown error occurred';
            if (error instanceof Error) {
                errorMessage = error.message;
            } else if (typeof error === 'string') {
                errorMessage = error;
            }
            responseData = {
                status: 0,
                statusText: 'Error',
                headers: {},
                body: errorMessage,
                size: errorMessage.length,
                time: endTime - startTime,
                cookies: {}
            };
        }
        return responseData;
    }

    function createNewRequestPanel() {
        const panel = vscode.window.createWebviewPanel(
            'restExplorer.newRequest',
            'New Request',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );
        panel.webview.html = getNewRequestContent();
        currentPanels.push(panel);
        panel.onDidDispose(() => {
            const index = currentPanels.indexOf(panel);
            if (index !== -1) {
                currentPanels.splice(index, 1);
            }
        });

        // Handle messages from the webview
        panel.webview.onDidReceiveMessage(
            async (message: WebviewMessage) => {
                if (message.command === 'makeRequest' && message.url && message.method) {
                    try {
                        const response = await makeRequest(message);
                        panel.webview.postMessage({
                            command: 'response',
                            data: response
                        });
                    } catch (error) {
                        console.error('Error making request:', error);
                    }
                }
            },
            undefined,
            context.subscriptions
        );

        // Hide the system pane
        vscode.commands.executeCommand('workbench.action.closePanel');
    }

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            RestExplorerViewProvider.viewType,
            new RestExplorerViewProvider(context, createNewRequestPanel)
        )
    );

    let disposable = vscode.commands.registerCommand('restExplorer.newRequest', () => {
        createNewRequestPanel();
    });
    context.subscriptions.push(disposable);

    // Generate webview content for new request panel
    function getNewRequestContent(): string {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    padding: 10px;
                    display: flex;
                    flex-direction: column;
                    height: 100vh;
                    margin: 0;
                    overflow: hidden;
                }
                .request-line {
                    display: flex;
                    gap: 10px;
                    margin-bottom: 10px;
                    padding: 10px;
                    background-color: var(--vscode-editor-background);
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .main-content {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    min-height: 0;
                    overflow: hidden;
                }
                .request-area {
                    flex: 1;
                    display: flex;
                    flex-direction: column;
                    min-height: 0;
                    overflow: auto;
                }
                .response-panel {
                    height: 45%;
                    min-height: 200px;
                    display: flex;
                    flex-direction: column;
                    overflow: hidden;
                    border-top: 1px solid var(--vscode-panel-border);
                    background-color: var(--vscode-editor-background);
                    position: relative;
                }
                .resize-handle {
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    height: 4px;
                    cursor: ns-resize;
                    background-color: var(--vscode-panel-border);
                    user-select: none;
                    -webkit-user-select: none;
                }
                .resize-handle:hover {
                    background-color: var(--vscode-button-background);
                }
                .resize-handle.active {
                    background-color: var(--vscode-button-background);
                }
                select, input, button {
                    padding: 5px;
                    border: 1px solid var(--vscode-input-border);
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                }
                button {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    cursor: pointer;
                }
                button:hover {
                    background-color: var(--vscode-button-hoverBackground);
                }
                .tabs {
                    display: flex;
                    gap: 10px;
                    margin-bottom: 10px;
                    padding: 10px;
                    background-color: var(--vscode-editor-background);
                }
                .tab {
                    padding: 5px 10px;
                    cursor: pointer;
                    border: 1px solid var(--vscode-panel-border);
                }
                .tab.active {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                }
                .tab-content {
                    display: none;
                    margin-bottom: 10px;
                    padding: 10px;
                    overflow: auto;
                }
                .tab-content.active {
                    display: block;
                }
                .param-row, .header-row {
                    display: flex;
                    gap: 10px;
                    margin-bottom: 5px;
                    align-items: center;
                }
                .param-row input, .header-row input {
                    flex: 1;
                }
                .param-row input:disabled, .header-row input:disabled {
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    opacity: 0.7;
                }
                .auth-tabs {
                    display: flex;
                    gap: 10px;
                    margin-bottom: 10px;
                }
                .auth-tab {
                    padding: 5px 10px;
                    cursor: pointer;
                    border: 1px solid var(--vscode-panel-border);
                }
                .auth-tab.active {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                }
                .auth-content {
                    display: none;
                    overflow: auto;
                }
                .auth-content.active {
                    display: block;
                }
                .auth-field {
                    margin-bottom: 10px;
                }
                .auth-field label {
                    display: block;
                    margin-bottom: 5px;
                }
                .auth-field input, .auth-field textarea {
                    width: 100%;
                    padding: 5px;
                    border: 1px solid var(--vscode-input-border);
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                }
                .auth-field textarea {
                    height: 100px;
                    resize: vertical;
                }
                .response-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    padding: 10px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                    background-color: var(--vscode-editor-background);
                    flex-shrink: 0;
                }
                .response-info {
                    display: flex;
                    gap: 20px;
                }
                .response-info-item {
                    display: flex;
                    align-items: center;
                    gap: 5px;
                }
                .response-tabs {
                    display: flex;
                    gap: 10px;
                }
                .response-tab {
                    padding: 5px 10px;
                    cursor: pointer;
                    border: 1px solid var(--vscode-panel-border);
                }
                .response-tab.active {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                }
                .response-content {
                    flex: 1;
                    overflow: auto;
                    padding: 10px;
                }
                .response-tab-content {
                    display: none;
                    height: 100%;
                }
                .response-tab-content.active {
                    display: block;
                }
                .response-content pre {
                    margin: 0;
                    white-space: pre-wrap;
                }
                .response-content table {
                    width: 100%;
                    border-collapse: collapse;
                }
                .response-content th, .response-content td {
                    padding: 5px;
                    border: 1px solid var(--vscode-panel-border);
                    text-align: left;
                }
                .response-content th {
                    background-color: var(--vscode-editor-background);
                }
                #requestBody {
                    width: 100%;
                    height: 200px;
                    margin-bottom: 10px;
                    background-color: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    font-family: var(--vscode-font-family);
                    padding: 8px;
                    resize: vertical;
                }
            </style>
        </head>
        <body>
            <div class="request-line">
                <select id="method">
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                    <option value="PUT">PUT</option>
                    <option value="DELETE">DELETE</option>
                    <option value="HEAD">HEAD</option>
                    <option value="PATCH">PATCH</option>
                    <option value="OPTIONS">OPTIONS</option>
                </select>
                <input type="text" id="url" placeholder="Enter URL" style="flex-grow: 1;">
                <button onclick="sendRequest()">Send</button>
            </div>
            
            <div class="main-content">
                <div class="request-area">
                    <div class="tabs">
                        <div class="tab active" data-tab="query">Query</div>
                        <div class="tab" data-tab="headers">Headers</div>
                        <div class="tab" data-tab="auth">Auth</div>
                        <div class="tab" data-tab="body">Body</div>
                    </div>

                    <div id="query" class="tab-content active">
                        <div id="queryParams">
                            <div class="param-row">
                                <input type="checkbox" checked>
                                <input type="text" placeholder="Key" value="parameter" data-default="parameter">
                                <input type="text" placeholder="Value" value="value" data-default="value">
                            </div>
                        </div>
                    </div>

                    <div id="headers" class="tab-content">
                        <div id="headerParams">
                            <div class="header-row">
                                <input type="checkbox" checked>
                                <input type="text" placeholder="Key" value="Accept" data-default="Accept">
                                <input type="text" placeholder="Value" value="*/*" data-default="*/*">
                            </div>
                            <div class="header-row">
                                <input type="checkbox" checked>
                                <input type="text" placeholder="Key" value="User-Agent" data-default="User-Agent">
                                <input type="text" placeholder="Value" value="Mozilla/5.0" data-default="Mozilla/5.0">
                            </div>
                            <div class="header-row">
                                <input type="checkbox">
                                <input type="text" placeholder="Key" value="header" data-default="header">
                                <input type="text" placeholder="Value" value="text value" data-default="text value">
                            </div>
                        </div>
                    </div>

                    <div id="auth" class="tab-content">
                        <div class="auth-tabs">
                            <div class="auth-tab active" data-auth="none">None</div>
                            <div class="auth-tab" data-auth="basic">Basic</div>
                            <div class="auth-tab" data-auth="bearer">Bearer</div>
                        </div>
                        <div id="auth-none" class="auth-content active"></div>
                        <div id="auth-basic" class="auth-content">
                            <div class="auth-field">
                                <label>Username</label>
                                <input type="text" id="username" placeholder="username">
                            </div>
                            <div class="auth-field">
                                <label>Password</label>
                                <input type="password" id="password" placeholder="password">
                            </div>
                        </div>
                        <div id="auth-bearer" class="auth-content">
                            <div class="auth-field">
                                <label>Token</label>
                                <textarea id="token" placeholder="enter token"></textarea>
                            </div>
                        </div>
                    </div>

                    <div id="body" class="tab-content">
                        <textarea id="requestBody" placeholder="Enter request body"></textarea>
                    </div>
                </div>

                <div class="response-panel" id="responsePanel">
                    <div class="resize-handle" id="resizeHandle"></div>
                    <div class="response-header">
                        <div class="response-info">
                            <div class="response-info-item">
                                <span>Status:</span>
                                <span id="responseStatus">-</span>
                            </div>
                            <div class="response-info-item">
                                <span>Size:</span>
                                <span id="responseSize">-</span>
                            </div>
                            <div class="response-info-item">
                                <span>Time:</span>
                                <span id="responseTime">-</span>
                            </div>
                        </div>
                        <div class="response-tabs">
                            <div class="response-tab active" data-response="response">Response</div>
                            <div class="response-tab" data-response="headers">Headers</div>
                            <div class="response-tab" data-response="cookies">Cookies</div>
                        </div>
                    </div>
                    <div class="response-content">
                        <div id="responseContent" class="response-tab-content active">
                            <pre id="responseBody"></pre>
                        </div>
                        <div id="headersContent" class="response-tab-content">
                            <table id="headersTable"></table>
                        </div>
                        <div id="cookiesContent" class="response-tab-content">
                            <table id="cookiesTable"></table>
                        </div>
                    </div>
                </div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                let activeTab = 'query';
                let activeAuthTab = 'none';
                let activeResponseTab = 'response';
                let isResizing = false;
                let startY = 0;
                let startHeight = 0;

                // Prevent UI flash
                document.body.classList.add('loading');
                window.addEventListener('load', () => {
                    document.body.classList.remove('loading');
                    initializeEventListeners();
                    initializeResizeHandle();
                });

                function initializeResizeHandle() {
                    const handle = document.getElementById('resizeHandle');
                    const panel = document.getElementById('responsePanel');

                    handle.addEventListener('mousedown', (e) => {
                        isResizing = true;
                        startY = e.clientY;
                        startHeight = panel.offsetHeight;
                        handle.classList.add('active');
                        e.preventDefault();
                    });

                    document.addEventListener('mousemove', (e) => {
                        if (!isResizing) return;
                        
                        const deltaY = e.clientY - startY;
                        const newHeight = Math.max(200, startHeight - deltaY);
                        panel.style.height = newHeight + 'px';
                        e.preventDefault();
                    });

                    document.addEventListener('mouseup', () => {
                        if (isResizing) {
                            isResizing = false;
                            handle.classList.remove('active');
                        }
                    });

                    // Prevent text selection during resize
                    handle.addEventListener('selectstart', (e) => {
                        e.preventDefault();
                    });
                }

                function initializeEventListeners() {
                    // Tab click handlers
                    document.querySelectorAll('.tab').forEach(tab => {
                        tab.addEventListener('click', () => {
                            switchTab(tab.dataset.tab);
                        });
                    });

                    document.querySelectorAll('.auth-tab').forEach(tab => {
                        tab.addEventListener('click', () => {
                            switchAuthTab(tab.dataset.auth);
                        });
                    });

                    document.querySelectorAll('.response-tab').forEach(tab => {
                        tab.addEventListener('click', () => {
                            switchResponseTab(tab.dataset.response);
                        });
                    });

                    // Setup textbox behavior for initial rows
                    setupTextboxBehavior(document.getElementById('queryParams'));
                    setupTextboxBehavior(document.getElementById('headerParams'));

                    // Add event listeners for parameter inputs
                    document.getElementById('queryParams').addEventListener('input', (e) => {
                        if (e.target.matches('input[type="text"]')) {
                            handleParamInput(e.target, true);
                        }
                    });

                    document.getElementById('headerParams').addEventListener('input', (e) => {
                        if (e.target.matches('input[type="text"]')) {
                            handleParamInput(e.target, false);
                        }
                    });

                    // Add event listeners for checkboxes
                    document.getElementById('queryParams').addEventListener('change', (e) => {
                        if (e.target.matches('input[type="checkbox"]')) {
                            const row = e.target.closest('.param-row');
                            const keyInput = row.querySelector('input[placeholder="Key"]');
                            const valueInput = row.querySelector('input[placeholder="Value"]');
                            if (!e.target.checked) {
                                keyInput.value = keyInput.dataset.default;
                                valueInput.value = valueInput.dataset.default;
                                delete keyInput.dataset.userModified;
                                delete valueInput.dataset.userModified;
                            }
                        }
                    });

                    document.getElementById('headerParams').addEventListener('change', (e) => {
                        if (e.target.matches('input[type="checkbox"]')) {
                            const row = e.target.closest('.header-row');
                            const keyInput = row.querySelector('input[placeholder="Key"]');
                            const valueInput = row.querySelector('input[placeholder="Value"]');
                            if (!e.target.checked) {
                                keyInput.value = keyInput.dataset.default;
                                valueInput.value = valueInput.dataset.default;
                                delete keyInput.dataset.userModified;
                                delete valueInput.dataset.userModified;
                            }
                        }
                    });
                }

                function switchTab(tabName) {
                    document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
                    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
                    document.querySelector('.tab[data-tab="' + tabName + '"]').classList.add('active');
                    document.getElementById(tabName).classList.add('active');
                    activeTab = tabName;
                }

                function switchAuthTab(tabName) {
                    document.querySelectorAll('.auth-tab').forEach(tab => tab.classList.remove('active'));
                    document.querySelectorAll('.auth-content').forEach(content => content.classList.remove('active'));
                    document.querySelector('.auth-tab[data-auth="' + tabName + '"]').classList.add('active');
                    document.getElementById('auth-' + tabName).classList.add('active');
                    activeAuthTab = tabName;
                }

                function switchResponseTab(tabName) {
                    document.querySelectorAll('.response-tab').forEach(tab => tab.classList.remove('active'));
                    document.querySelectorAll('.response-tab-content').forEach(content => content.classList.remove('active'));
                    document.querySelector('.response-tab[data-response="' + tabName + '"]').classList.add('active');
                    document.getElementById(tabName + 'Content').classList.add('active');
                    activeResponseTab = tabName;
                }

                function handleParamInput(input, isQuery = true) {
                    const row = input.closest('.param-row, .header-row');
                    const checkbox = row.querySelector('input[type="checkbox"]');
                    const keyInput = row.querySelector('input[placeholder="Key"]');
                    const valueInput = row.querySelector('input[placeholder="Value"]');

                    if (input.value) {
                        checkbox.checked = true;

                        // Add new row if this is the last row
                        const container = document.getElementById(isQuery ? 'queryParams' : 'headerParams');
                        if (row === container.lastElementChild) {
                            const newRow = document.createElement('div');
                            newRow.className = isQuery ? 'param-row' : 'header-row';
                            const keyVal = isQuery ? 'parameter' : 'header';
                            const valueVal = isQuery ? 'value' : 'text value';
                            newRow.innerHTML =
                                '<input type="checkbox">' +
                                '<input type="text" placeholder="Key" value="' + keyVal + '" data-default="' + keyVal + '">' +
                                '<input type="text" placeholder="Value" value="' + valueVal + '" data-default="' + valueVal + '">';
                            container.appendChild(newRow);
                            setupTextboxBehavior(newRow);
                        }
                    }
                }

                function setupTextboxBehavior(container) {
                    const textboxes = container.querySelectorAll('input[type="text"]');
                    textboxes.forEach(textbox => {
                        // Store original value on first focus
                        textbox.addEventListener('focus', () => {
                            if (!textbox.dataset.userModified) {
                                textbox.value = '';
                            }
                        });

                        // Restore default if empty on blur
                        textbox.addEventListener('blur', () => {
                            if (!textbox.value && !textbox.dataset.userModified) {
                                textbox.value = textbox.dataset.default;
                            }
                        });

                        // Mark as user modified on input
                        textbox.addEventListener('input', () => {
                            textbox.dataset.userModified = 'true';
                        });
                    });
                }

                function sendRequest() {
                    const method = document.getElementById('method').value;
                    const url = document.getElementById('url').value;
                    
                    // Collect query parameters
                    const query = {};
                    document.querySelectorAll('#queryParams .param-row').forEach(row => {
                        const checkbox = row.querySelector('input[type="checkbox"]');
                        const keyInput = row.querySelector('input[placeholder="Key"]');
                        const valueInput = row.querySelector('input[placeholder="Value"]');
                        if (checkbox.checked && keyInput.value && valueInput.value) {
                            query[keyInput.value] = valueInput.value;
                        }
                    });

                    // Collect headers
                    const headers = {};
                    document.querySelectorAll('#headerParams .header-row').forEach(row => {
                        const checkbox = row.querySelector('input[type="checkbox"]');
                        const keyInput = row.querySelector('input[placeholder="Key"]');
                        const valueInput = row.querySelector('input[placeholder="Value"]');
                        if (checkbox.checked && keyInput.value && valueInput.value) {
                            headers[keyInput.value] = valueInput.value;
                        }
                    });

                    // Collect auth
                    let auth = { type: 'none' };
                    if (activeAuthTab === 'basic') {
                        auth = {
                            type: 'basic',
                            username: document.getElementById('username').value,
                            password: document.getElementById('password').value
                        };
                    } else if (activeAuthTab === 'bearer') {
                        auth = {
                            type: 'bearer',
                            token: document.getElementById('token').value
                        };
                    }

                    // Get body
                    const body = document.getElementById('requestBody').value;

                    vscode.postMessage({
                        command: 'makeRequest',
                        method,
                        url,
                        query,
                        headers,
                        auth,
                        body
                    });
                }

                // Handle response from extension
                window.addEventListener('message', event => {
                    const message = event.data;
                    if (message.command === 'response') {
                        updateResponsePanel(message.data);
                    }
                });

                function updateResponsePanel(data) {
                    // Update status info
                    document.getElementById('responseStatus').textContent = data.status + ' ' + data.statusText;
                    document.getElementById('responseSize').textContent = data.size + ' bytes';
                    document.getElementById('responseTime').textContent = data.time + 'ms';

                    // Update response body
                    const responseBody = document.getElementById('responseBody');
                    if (data.status === 0) {
                        responseBody.textContent = 'Error: ' + data.body;
                    } else {
                        responseBody.textContent = data.body;
                    }

                    // Update headers table
                    const headersTable = document.getElementById('headersTable');
                    headersTable.innerHTML = '<tr><th>Name</th><th>Value</th></tr>' +
                        Object.entries(data.headers)
                            .map(([name, value]) => '<tr><td>' + name + '</td><td>' + value + '</td></tr>')
                            .join('');

                    // Update cookies table
                    const cookiesTable = document.getElementById('cookiesTable');
                    cookiesTable.innerHTML = '<tr><th>Name</th><th>Value</th></tr>' +
                        Object.entries(data.cookies)
                            .map(([name, value]) => '<tr><td>' + name + '</td><td>' + value + '</td></tr>')
                            .join('');
                }
            </script>
        </body>
        </html>`;
    }
}

export function deactivate() {} 