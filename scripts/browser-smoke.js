import assert from "node:assert/strict";
import {once} from "node:events";
import {access} from "node:fs/promises";
import http from "node:http";

import {createAuthSession} from "../src/services/auth/auth-session.js";
import {registerBrowserTools} from "../src/tools/register-browser-tools.js";

const STORAGE_KEY = "auth";
const VALID_LOGIN = "demo@example.com";
const VALID_PASSWORD = "secret";

class FakeMcpServer {
    constructor() {
        this.tools = new Map();
    }

    registerTool(name, _spec, handler) {
        this.tools.set(name, handler);
    }

    async call(name, input = {}) {
        const handler = this.tools.get(name);
        if (!handler) {
            throw new Error(`Tool '${name}' is not registered.`);
        }

        const result = await handler(input);
        return result.structuredContent;
    }
}

function readJsonBody(request) {
    return new Promise((resolve, reject) => {
        let buffer = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
            buffer += chunk;
        });
        request.on("end", () => {
            if (!buffer) {
                resolve({});
                return;
            }

            try {
                resolve(JSON.parse(buffer));
            } catch (error) {
                reject(error);
            }
        });
        request.on("error", reject);
    });
}

function sendJson(response, statusCode, payload) {
    response.writeHead(statusCode, {"content-type": "application/json"});
    response.end(JSON.stringify(payload));
}

function renderPage(content) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Profile | Outvento</title>
    <style>
        html, body {
            margin: 0;
            padding: 0;
            font-family: sans-serif;
        }
        .page-shell {
            padding-top: 70px;
            min-height: 100vh;
            background: #f3f4f6;
        }
        .account-layout {
            display: flex;
            align-items: flex-start;
            gap: 24px;
            padding: 0 24px 24px;
        }
        .profile-sidebar,
        .account-home,
        .security-page,
        .profile-page {
            display: block;
            padding-top: 12px;
            margin-top: 0;
            background: white;
            border: 1px solid #d1d5db;
            border-radius: 12px;
        }
        .profile-sidebar {
            width: 220px;
            min-height: 240px;
            padding: 16px;
            box-sizing: border-box;
        }
        .profile-page {
            flex: 1;
            min-height: 1672px;
            padding: 12px 16px 24px;
            box-sizing: border-box;
        }
        .account-home,
        .security-page {
            margin: 0 24px 24px;
            padding: 16px;
        }
    </style>
</head>
<body>${content}</body>
</html>`;
}

function renderProtectedPage(content) {
    return renderPage(`
        <div class="protected-root">${content}</div>
        <script>
            const raw = window.localStorage.getItem(${JSON.stringify(STORAGE_KEY)});
            const auth = raw ? JSON.parse(raw) : null;
            if (!auth || auth.accessToken !== 'access-token-demo') {
                window.location.href = '/login';
            }
        </script>
    `);
}

async function startFixtureServer() {
    const server = http.createServer(async (request, response) => {
        const requestUrl = new URL(request.url || "/", `http://${request.headers.host}`);

        if (request.method === "POST" && requestUrl.pathname === "/api/v1/login") {
            const body = await readJsonBody(request);
            if (body.login === VALID_LOGIN && body.password === VALID_PASSWORD) {
                sendJson(response, 200, {
                    content: {
                        accessToken: "access-token-demo",
                        refreshToken: "refresh-token-demo",
                        tokenType: "Bearer"
                    }
                });
                return;
            }

            sendJson(response, 401, {message: "Invalid credentials"});
            return;
        }

        if (request.method === "GET" && requestUrl.pathname === "/api/v1/profile-error") {
            sendJson(response, 500, {message: "Synthetic profile failure"});
            return;
        }

        if (request.method === "GET" && requestUrl.pathname === "/api/v1/abort-me") {
            sendJson(response, 204, {});
            return;
        }

        if (request.method === "GET" && requestUrl.pathname === "/login") {
            response.writeHead(200, {"content-type": "text/html; charset=utf-8"});
            response.end(renderPage('<main class="login-page">Login page</main>'));
            return;
        }

        if (request.method === "GET" && requestUrl.pathname === "/account/profile") {
            response.writeHead(200, {"content-type": "text/html; charset=utf-8"});
            response.end(renderProtectedPage(`
                <div class="page-shell">
                    <div class="account-layout">
                        <aside class="profile-sidebar">Sidebar</aside>
                        <section class="profile-page">
                            <div>Profile page</div>
                            <label>
                                Profile name
                                <input class="profile-input" value="" />
                            </label>
                            <button class="save-button" type="button" data-role="primary">Save</button>
                            <div class="save-status">idle</div>
                            <label>
                                Shortcut
                                <input class="shortcut-input" value="" />
                            </label>
                            <div class="keyboard-status">pending</div>
                        </section>
                    </div>
                </div>
                <script>
                    const profileInput = document.querySelector('.profile-input');
                    const saveButton = document.querySelector('.save-button');
                    const saveStatus = document.querySelector('.save-status');
                    const shortcutInput = document.querySelector('.shortcut-input');
                    const keyboardStatus = document.querySelector('.keyboard-status');

                    saveButton.addEventListener('click', () => {
                        saveStatus.textContent = profileInput.value || 'empty';
                    });

                    shortcutInput.addEventListener('keydown', (event) => {
                        if (event.key === 'Enter') {
                            keyboardStatus.textContent = shortcutInput.value || 'enter';
                        }
                    });

                    console.log('[vite] connecting...');
                    console.warn('Download the React DevTools for a better development experience: https://react.dev/link/devtools');
                    console.warn('Synthetic profile console warning');
                    console.error('Synthetic profile console error');

                    const controller = new AbortController();
                    fetch('/api/v1/abort-me', {signal: controller.signal}).catch(() => undefined);
                    controller.abort();
                    fetch('/api/v1/profile-error').catch(() => undefined);
                </script>
            `));
            return;
        }

        if (request.method === "GET" && requestUrl.pathname === "/account") {
            response.writeHead(200, {"content-type": "text/html; charset=utf-8"});
            response.end(renderProtectedPage(`
                <div class="page-shell">
                    <main class="account-home">Account home</main>
                </div>
            `));
            return;
        }

        if (request.method === "GET" && requestUrl.pathname === "/account/security") {
            response.writeHead(200, {"content-type": "text/html; charset=utf-8"});
            response.end(renderProtectedPage(`
                <div class="page-shell">
                    <main class="security-page">Security page</main>
                </div>
            `));
            return;
        }

        if (request.method === "GET" && requestUrl.pathname === "/") {
            response.writeHead(200, {"content-type": "text/html; charset=utf-8"});
            response.end(renderPage('<main class="home-page">Home page</main>'));
            return;
        }

        response.writeHead(404, {"content-type": "text/plain; charset=utf-8"});
        response.end("Not found");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return {
        server,
        baseUrl: `http://127.0.0.1:${port}`
    };
}

function createBrowserToolOptions({sharedAuthSession} = {}) {
    return {
        browserConfig: {
            headlessDefault: true,
            sessionTtlMs: 60000,
            cleanupIntervalMs: 1000,
            navigationTimeoutMs: 15000,
            actionTimeoutMs: 15000,
            maxConsoleEntries: 200,
            maxNetworkErrors: 200,
            frontendAuthStorageKey: STORAGE_KEY,
            artifactsDir: new URL("../artifacts/browser", import.meta.url).pathname
        },
        authConfig: {
            loginPath: "/api/v1/login",
            loginMethod: "post",
            usernameField: "login",
            passwordField: "password",
            tokenFieldPath: "content.accessToken",
            refreshTokenFieldPath: "content.refreshToken",
            tokenTypeFieldPath: "content.tokenType",
            defaultTokenType: "Bearer",
            staticToken: "",
            staticRefreshToken: "",
            username: "",
            password: "",
            autoLogin: true
        },
        apiConfig: {
            requestTimeoutMs: 15000,
            retryOnUnauthorized: true
        },
        ...(sharedAuthSession ? {sharedAuthSession} : {})
    };
}

async function run() {
    const fixture = await startFixtureServer();
    const fakeServer = new FakeMcpServer();
    const authlessServer = new FakeMcpServer();
    const staleAuthServer = new FakeMcpServer();
    const sharedAuthSession = createAuthSession({
        authConfig: createBrowserToolOptions().authConfig,
        fetchImpl: fetch,
        timeoutMs: 15000,
        buildBaseUrl: () => fixture.baseUrl
    });
    await sharedAuthSession.login({login: VALID_LOGIN, password: VALID_PASSWORD, baseUrlOverride: fixture.baseUrl});

    await registerBrowserTools(fakeServer, createBrowserToolOptions({sharedAuthSession}));
    await registerBrowserTools(authlessServer, createBrowserToolOptions());
    await registerBrowserTools(staleAuthServer, createBrowserToolOptions({
        sharedAuthSession: {
            getTokens() {
                return {
                    accessToken: "stale-access-token",
                    refreshToken: null,
                    tokenType: "Bearer",
                    authenticated: true
                };
            },
            login: async () => ({authenticated: true}),
            clearAuth() {},
            ensureAuthenticated: async () => true,
            getState() {
                return {
                    authenticated: true,
                    tokenType: "Bearer",
                    hasRefreshToken: false,
                    hasStoredCredentials: false,
                    source: "session"
                };
            }
        }
    }));

    const smokeResults = {};
    let sessionId = null;
    let restoredSessionId = null;
    let profileSessionId = null;
    let accountSessionId = null;
    let securitySessionId = null;

    try {
        smokeResults.browser_open_session = await fakeServer.call("browser_open_session", {
            baseUrl: fixture.baseUrl,
            device: "iPhone 14 Pro Max",
            headless: true
        });
        assert.equal(smokeResults.browser_open_session.ok, true);
        sessionId = smokeResults.browser_open_session.sessionId;

        smokeResults.browser_auth_from_api_login = await fakeServer.call("browser_auth_from_api_login", {
            sessionId,
            baseUrl: fixture.baseUrl,
            login: VALID_LOGIN,
            password: "wrong-password-triggers-shared-auth-fallback",
            storageKey: STORAGE_KEY
        });
        assert.equal(smokeResults.browser_auth_from_api_login.ok, true);
        assert.equal(smokeResults.browser_auth_from_api_login.didFallbackToExistingMcpAuth, true);
        assert.equal(smokeResults.browser_auth_from_api_login.usedExistingMcpAuth, true);

        smokeResults.browser_navigate = await fakeServer.call("browser_navigate", {
            sessionId,
            url: `${fixture.baseUrl}/account/profile`,
            waitUntil: "domcontentloaded"
        });
        assert.equal(smokeResults.browser_navigate.ok, true);

        smokeResults.browser_wait_for = await fakeServer.call("browser_wait_for", {
            sessionId,
            selector: ".profile-page",
            state: "visible",
            timeoutMs: 15000
        });
        assert.equal(smokeResults.browser_wait_for.ok, true);

        smokeResults.browser_screenshot_full = await fakeServer.call("browser_screenshot", {
            sessionId,
            type: "fullPage",
            fileName: "account-profile-full.png"
        });
        assert.equal(smokeResults.browser_screenshot_full.ok, true);
        await access(smokeResults.browser_screenshot_full.path);

        smokeResults.browser_screenshot_element = await fakeServer.call("browser_screenshot", {
            sessionId,
            type: "element",
            selector: ".profile-page",
            fileName: "account-profile-profile.png"
        });
        assert.equal(smokeResults.browser_screenshot_element.ok, true);
        await access(smokeResults.browser_screenshot_element.path);

        smokeResults.browser_get_bounding_rect = await fakeServer.call("browser_get_bounding_rect", {
            sessionId,
            selector: ".profile-page"
        });
        assert.equal(smokeResults.browser_get_bounding_rect.ok, true);
        assert.ok(smokeResults.browser_get_bounding_rect.rect.top >= 0);
        assert.ok(smokeResults.browser_get_bounding_rect.rect.height > 0);

        smokeResults.browser_get_computed_styles = await fakeServer.call("browser_get_computed_styles", {
            sessionId,
            selector: ".profile-page",
            includeParents: true,
            stopAt: "body"
        });
        assert.equal(smokeResults.browser_get_computed_styles.ok, true);
        assert.equal(smokeResults.browser_get_computed_styles.chain[0].computedStyles["padding-top"], "12px");

        smokeResults.browser_fill = await fakeServer.call("browser_fill", {
            sessionId,
            selector: ".profile-input",
            value: "Ada Lovelace"
        });
        assert.equal(smokeResults.browser_fill.ok, true);

        smokeResults.browser_click = await fakeServer.call("browser_click", {
            sessionId,
            selector: ".save-button"
        });
        assert.equal(smokeResults.browser_click.ok, true);

        smokeResults.browser_fill_shortcut = await fakeServer.call("browser_fill", {
            sessionId,
            selector: ".shortcut-input",
            value: "Pressed via Enter"
        });
        assert.equal(smokeResults.browser_fill_shortcut.ok, true);

        smokeResults.browser_press = await fakeServer.call("browser_press", {
            sessionId,
            selector: ".shortcut-input",
            key: "Enter"
        });
        assert.equal(smokeResults.browser_press.ok, true);

        smokeResults.browser_evaluate = await fakeServer.call("browser_evaluate", {
            sessionId,
            expression: "({ saved: document.querySelector('.save-status').textContent, keyboard: document.querySelector('.keyboard-status').textContent, accessToken: JSON.parse(localStorage.getItem('auth')).accessToken })"
        });
        assert.equal(smokeResults.browser_evaluate.ok, true);
        assert.equal(smokeResults.browser_evaluate.result.saved, "Ada Lovelace");
        assert.equal(smokeResults.browser_evaluate.result.keyboard, "Pressed via Enter");
        assert.equal(smokeResults.browser_evaluate.result.accessToken, "access-token-demo");

        smokeResults.browser_assert_layout = await fakeServer.call("browser_assert_layout", {
            sessionId,
            selector: ".profile-page",
            assertions: {
                widthGreaterThanOrEqual: 120,
                heightGreaterThanOrEqual: 500,
                topGreaterThanOrEqual: 0,
                topLessThanOrEqual: 180
            },
            presets: {
                sidebarDoesNotPushContentDown: {
                    sidebarSelector: ".profile-sidebar",
                    maxTopDifference: 24
                }
            }
        });
        assert.equal(smokeResults.browser_assert_layout.ok, true);
        assert.equal(smokeResults.browser_assert_layout.passed, true);

        smokeResults.browser_assert_layout_sidebar = await fakeServer.call("browser_assert_layout", {
            sessionId,
            selector: ".profile-sidebar",
            presets: {
                nearTop: {
                    maxTop: 180,
                    minTop: 0
                },
                withinViewport: {
                    padding: 0
                }
            }
        });
        assert.equal(smokeResults.browser_assert_layout_sidebar.ok, true);
        assert.equal(smokeResults.browser_assert_layout_sidebar.passed, true);

        smokeResults.browser_get_text = await fakeServer.call("browser_get_text", {
            sessionId,
            selector: ".save-status"
        });
        assert.equal(smokeResults.browser_get_text.ok, true);
        assert.equal(smokeResults.browser_get_text.text, "Ada Lovelace");

        smokeResults.browser_get_attribute = await fakeServer.call("browser_get_attribute", {
            sessionId,
            selector: ".save-button",
            name: "data-role"
        });
        assert.equal(smokeResults.browser_get_attribute.ok, true);
        assert.equal(smokeResults.browser_get_attribute.present, true);
        assert.equal(smokeResults.browser_get_attribute.value, "primary");

        smokeResults.browser_save_storage_state = await fakeServer.call("browser_save_storage_state", {
            sessionId,
            fileName: "auth-state.json"
        });
        assert.equal(smokeResults.browser_save_storage_state.ok, true);
        assert.ok(smokeResults.browser_save_storage_state.originsCount >= 1);
        await access(smokeResults.browser_save_storage_state.path);

        smokeResults.browser_get_console_logs = await fakeServer.call("browser_get_console_logs", {sessionId});
        assert.equal(smokeResults.browser_get_console_logs.ok, true);
        assert.ok(smokeResults.browser_get_console_logs.logs.some((entry) => entry.text.includes("Synthetic profile console error")));
        assert.ok(smokeResults.browser_get_console_logs.consoleWarnings.some((entry) => entry.text.includes("Synthetic profile console warning")));
        assert.ok(smokeResults.browser_get_console_logs.ignoredNoiseCount >= 2);
        assert.ok(!smokeResults.browser_get_console_logs.logs.some((entry) => entry.text.includes("[vite]")));

        smokeResults.browser_get_network_errors = await fakeServer.call("browser_get_network_errors", {sessionId});
        assert.equal(smokeResults.browser_get_network_errors.ok, true);
        assert.ok(smokeResults.browser_get_network_errors.requests.some((entry) => entry.status === 500 && entry.url.endsWith("/api/v1/profile-error")));
        assert.ok(!smokeResults.browser_get_network_errors.requests.some((entry) => String(entry.errorText || "").includes("ERR_ABORTED")));
        assert.ok(smokeResults.browser_get_network_errors.ignoredNoiseCount >= 2);

        smokeResults.browser_open_profile_page = await fakeServer.call("browser_open_profile_page", {
            baseUrl: fixture.baseUrl,
            device: "Desktop Chrome",
            headless: true,
            auth: {
                mode: "apiLogin",
                login: VALID_LOGIN,
                password: "fallback-via-shared-auth",
                storageKey: STORAGE_KEY
            }
        });
        assert.equal(smokeResults.browser_open_profile_page.ok, true);
        assert.equal(smokeResults.browser_open_profile_page.auth.didFallbackToExistingMcpAuth, true);
        profileSessionId = smokeResults.browser_open_profile_page.sessionId;

        smokeResults.browser_open_account_home = await fakeServer.call("browser_open_account_home", {
            baseUrl: fixture.baseUrl,
            headless: true,
            auth: {
                mode: "useExistingMcpAuth",
                storageKey: STORAGE_KEY
            }
        });
        assert.equal(smokeResults.browser_open_account_home.ok, true);
        accountSessionId = smokeResults.browser_open_account_home.sessionId;

        smokeResults.browser_open_security_page = await fakeServer.call("browser_open_security_page", {
            baseUrl: fixture.baseUrl,
            headless: true,
            auth: {
                mode: "useExistingMcpAuth",
                storageKey: STORAGE_KEY
            }
        });
        assert.equal(smokeResults.browser_open_security_page.ok, true);
        securitySessionId = smokeResults.browser_open_security_page.sessionId;

        smokeResults.browser_capture_profile_mobile = await fakeServer.call("browser_capture_profile_mobile", {
            baseUrl: fixture.baseUrl,
            headless: true,
            auth: {
                mode: "useExistingMcpAuth",
                storageKey: STORAGE_KEY
            }
        });
        assert.equal(smokeResults.browser_capture_profile_mobile.ok, true);
        assert.ok(smokeResults.browser_capture_profile_mobile.artifacts.fullPageScreenshot);
        assert.ok(smokeResults.browser_capture_profile_mobile.artifacts.elementScreenshot);
        assert.ok(smokeResults.browser_capture_profile_mobile.consoleErrors.some((entry) => entry.text.includes("Synthetic profile console error")));
        assert.ok(smokeResults.browser_capture_profile_mobile.consoleWarnings.some((entry) => entry.text.includes("Synthetic profile console warning")));
        assert.ok(smokeResults.browser_capture_profile_mobile.networkErrors.some((entry) => entry.status === 500));
        assert.ok(smokeResults.browser_capture_profile_mobile.ignoredNoiseCount >= 2);

        smokeResults.authless_browser_open_session = await authlessServer.call("browser_open_session", {
            baseUrl: fixture.baseUrl,
            headless: true
        });
        assert.equal(smokeResults.authless_browser_open_session.ok, true);

        smokeResults.browser_auth_from_api_login_failed = await authlessServer.call("browser_auth_from_api_login", {
            sessionId: smokeResults.authless_browser_open_session.sessionId,
            baseUrl: fixture.baseUrl,
            login: VALID_LOGIN,
            password: "definitely-wrong-password",
            storageKey: STORAGE_KEY
        });
        assert.equal(smokeResults.browser_auth_from_api_login_failed.ok, false);
        assert.equal(smokeResults.browser_auth_from_api_login_failed.error.code, "AUTH_API_LOGIN_FAILED");

        smokeResults.authless_browser_close_session = await authlessServer.call("browser_close_session", {
            sessionId: smokeResults.authless_browser_open_session.sessionId
        });
        assert.equal(smokeResults.authless_browser_close_session.ok, true);

        smokeResults.browser_inspect_page_redirected_to_login = await authlessServer.call("browser_inspect_page", {
            baseUrl: fixture.baseUrl,
            url: `${fixture.baseUrl}/account/profile`,
            headless: true,
            auth: {
                mode: "none"
            },
            targetSelector: ".profile-page"
        });
        assert.equal(smokeResults.browser_inspect_page_redirected_to_login.ok, false);
        assert.equal(smokeResults.browser_inspect_page_redirected_to_login.error.code, "AUTH_REDIRECTED_TO_LOGIN");
        assert.ok(smokeResults.browser_inspect_page_redirected_to_login.finalUrl.includes("/login"));
        assert.ok(smokeResults.browser_inspect_page_redirected_to_login.debugScreenshotPath);
        assert.ok(smokeResults.browser_inspect_page_redirected_to_login.debugHtmlPath);

        smokeResults.browser_inspect_page_session_expired = await staleAuthServer.call("browser_inspect_page", {
            baseUrl: fixture.baseUrl,
            url: `${fixture.baseUrl}/account/profile`,
            headless: true,
            auth: {
                mode: "useExistingMcpAuth",
                storageKey: STORAGE_KEY
            },
            targetSelector: ".profile-page"
        });
        assert.equal(smokeResults.browser_inspect_page_session_expired.ok, false);
        assert.equal(smokeResults.browser_inspect_page_session_expired.error.code, "AUTH_SESSION_EXPIRED");
        assert.ok(smokeResults.browser_inspect_page_session_expired.finalUrl.includes("/login"));
        assert.ok(smokeResults.browser_inspect_page_session_expired.debugScreenshotPath);
        assert.ok(smokeResults.browser_inspect_page_session_expired.debugHtmlPath);

        smokeResults.browser_close_profile_session = await fakeServer.call("browser_close_session", {sessionId: profileSessionId});
        assert.equal(smokeResults.browser_close_profile_session.ok, true);
        profileSessionId = null;

        smokeResults.browser_close_account_session = await fakeServer.call("browser_close_session", {sessionId: accountSessionId});
        assert.equal(smokeResults.browser_close_account_session.ok, true);
        accountSessionId = null;

        smokeResults.browser_close_security_session = await fakeServer.call("browser_close_session", {sessionId: securitySessionId});
        assert.equal(smokeResults.browser_close_security_session.ok, true);
        securitySessionId = null;

        smokeResults.browser_close_session = await fakeServer.call("browser_close_session", {sessionId});
        assert.equal(smokeResults.browser_close_session.ok, true);
        sessionId = null;

        smokeResults.browser_open_session_restored = await fakeServer.call("browser_open_session", {
            baseUrl: fixture.baseUrl,
            device: "Desktop Chrome",
            headless: true
        });
        assert.equal(smokeResults.browser_open_session_restored.ok, true);
        restoredSessionId = smokeResults.browser_open_session_restored.sessionId;

        smokeResults.browser_load_storage_state = await fakeServer.call("browser_load_storage_state", {
            sessionId: restoredSessionId,
            path: smokeResults.browser_save_storage_state.path
        });
        assert.equal(smokeResults.browser_load_storage_state.ok, true);
        assert.equal(smokeResults.browser_load_storage_state.reusedSession, true);

        smokeResults.browser_navigate_restored = await fakeServer.call("browser_navigate", {
            sessionId: restoredSessionId,
            url: `${fixture.baseUrl}/account/profile`,
            waitUntil: "domcontentloaded"
        });
        assert.equal(smokeResults.browser_navigate_restored.ok, true);

        smokeResults.browser_wait_for_restored = await fakeServer.call("browser_wait_for", {
            sessionId: restoredSessionId,
            selector: ".profile-page",
            state: "visible",
            timeoutMs: 15000
        });
        assert.equal(smokeResults.browser_wait_for_restored.ok, true);

        smokeResults.browser_evaluate_restored = await fakeServer.call("browser_evaluate", {
            sessionId: restoredSessionId,
            expression: "JSON.parse(localStorage.getItem('auth')).accessToken"
        });
        assert.equal(smokeResults.browser_evaluate_restored.ok, true);
        assert.equal(smokeResults.browser_evaluate_restored.result, "access-token-demo");

        smokeResults.browser_close_session_restored = await fakeServer.call("browser_close_session", {sessionId: restoredSessionId});
        assert.equal(smokeResults.browser_close_session_restored.ok, true);
        restoredSessionId = null;

        smokeResults.browser_inspect_page = await fakeServer.call("browser_inspect_page", {
            baseUrl: fixture.baseUrl,
            url: `${fixture.baseUrl}/account/profile`,
            device: "iPhone 12",
            headless: true,
            auth: {
                mode: "apiLogin",
                login: VALID_LOGIN,
                password: VALID_PASSWORD,
                storageKey: STORAGE_KEY
            },
            targetSelector: ".profile-page",
            captureStyles: true,
            captureConsole: true,
            captureNetworkErrors: true,
            takeFullPageScreenshot: true,
            takeElementScreenshot: true
        });
        assert.equal(smokeResults.browser_inspect_page.ok, true);
        assert.ok(smokeResults.browser_inspect_page.artifacts.fullPageScreenshot);
        assert.ok(smokeResults.browser_inspect_page.artifacts.elementScreenshot);
        assert.ok(smokeResults.browser_inspect_page.artifacts.stylesJson);

        console.log(JSON.stringify({ok: true, smokeResults}, null, 2));
    } finally {
        if (sessionId) {
            await fakeServer.call("browser_close_session", {sessionId}).catch(() => undefined);
        }
        if (restoredSessionId) {
            await fakeServer.call("browser_close_session", {sessionId: restoredSessionId}).catch(() => undefined);
        }
        if (profileSessionId) {
            await fakeServer.call("browser_close_session", {sessionId: profileSessionId}).catch(() => undefined);
        }
        if (accountSessionId) {
            await fakeServer.call("browser_close_session", {sessionId: accountSessionId}).catch(() => undefined);
        }
        if (securitySessionId) {
            await fakeServer.call("browser_close_session", {sessionId: securitySessionId}).catch(() => undefined);
        }
        await new Promise((resolve) => fixture.server.close(resolve));
    }
}

run().catch((error) => {
    console.error(JSON.stringify({ok: false, error: error.message, stack: error.stack}, null, 2));
    process.exitCode = 1;
});

