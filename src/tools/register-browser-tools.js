import * as z from "zod/v4";
import fetch from "node-fetch";

import {createAuthSession} from "../services/auth/auth-session.js";
import {createArtifactService} from "../services/browser/artifact-service.js";
import {createBrowserAuthBridge} from "../services/browser/auth-bridge.js";
import {browserError, toBrowserErrorPayload} from "../services/browser/browser-errors.js";
import {createPlaywrightService} from "../services/browser/playwright-service.js";
import {createBrowserSessionManager} from "../services/browser/session-manager.js";
import {asToolResult} from "./tool-result.js";

function suggestedFileName(prefix, extension = ".png") {
    const normalized = String(prefix || "artifact")
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^[._-]+/, "")
        .replace(/[._-]+$/, "");

    return `${normalized || "artifact"}${extension}`;
}

async function safelyCaptureDebugArtifacts({artifactService, sessionManager, sessionId, label}) {
    if (!sessionId) {
        return null;
    }

    const session = sessionManager.findSession(sessionId);
    if (!session) {
        return null;
    }

    return artifactService.captureDebugArtifacts(session, {label});
}

const viewportInputSchema = z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive()
});

const authInputSchema = z.object({
    mode: z.enum(["apiLogin", "useExistingMcpAuth", "none"]),
    login: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    storageKey: z.string().min(1).optional()
});

const layoutAssertionsSchema = z.object({
    topLessThanOrEqual: z.number().optional(),
    topLessThan: z.number().optional(),
    topGreaterThanOrEqual: z.number().optional(),
    topGreaterThan: z.number().optional(),
    leftLessThanOrEqual: z.number().optional(),
    leftLessThan: z.number().optional(),
    leftGreaterThanOrEqual: z.number().optional(),
    leftGreaterThan: z.number().optional(),
    rightLessThanOrEqual: z.number().optional(),
    rightLessThan: z.number().optional(),
    rightGreaterThanOrEqual: z.number().optional(),
    rightGreaterThan: z.number().optional(),
    bottomLessThanOrEqual: z.number().optional(),
    bottomLessThan: z.number().optional(),
    bottomGreaterThanOrEqual: z.number().optional(),
    bottomGreaterThan: z.number().optional(),
    widthLessThanOrEqual: z.number().optional(),
    widthLessThan: z.number().optional(),
    widthGreaterThanOrEqual: z.number().optional(),
    widthGreaterThan: z.number().optional(),
    heightLessThanOrEqual: z.number().optional(),
    heightLessThan: z.number().optional(),
    heightGreaterThanOrEqual: z.number().optional(),
    heightGreaterThan: z.number().optional(),
    xLessThanOrEqual: z.number().optional(),
    xLessThan: z.number().optional(),
    xGreaterThanOrEqual: z.number().optional(),
    xGreaterThan: z.number().optional(),
    yLessThanOrEqual: z.number().optional(),
    yLessThan: z.number().optional(),
    yGreaterThanOrEqual: z.number().optional(),
    yGreaterThan: z.number().optional()
});

const layoutPresetsSchema = z.object({
    nearTop: z.union([
        z.boolean(),
        z.object({
            maxTop: z.number().optional(),
            minTop: z.number().optional()
        })
    ]).optional(),
    withinViewport: z.union([
        z.boolean(),
        z.object({
            padding: z.number().optional()
        })
    ]).optional(),
    sidebarDoesNotPushContentDown: z.object({
        sidebarSelector: z.string().min(1),
        maxTopDifference: z.number().optional()
    }).optional()
});

function isLoginUrl(url) {
    try {
        return new URL(url).pathname.toLowerCase().includes("/login");
    } catch {
        return String(url || "").toLowerCase().includes("/login");
    }
}

export async function registerBrowserTools(server, {
    browserConfig,
    authConfig,
    apiConfig,
    sharedAuthSession,
    fetchImpl = fetch
}) {
    const artifactService = createArtifactService({rootDir: browserConfig.artifactsDir});
    await artifactService.ensureRootDir();

    const sessionManager = createBrowserSessionManager(browserConfig);
    const localAuthSession = sharedAuthSession || createAuthSession({
        authConfig,
        fetchImpl,
        timeoutMs: apiConfig.requestTimeoutMs,
        buildBaseUrl: () => {
            throw new Error("browser_auth_from_api_login requires baseUrl when Swagger auth session is unavailable.");
        }
    });
    const authBridge = createBrowserAuthBridge({
        sharedAuthSession,
        fallbackAuthSession: localAuthSession,
        defaultStorageKey: browserConfig.frontendAuthStorageKey
    });
    const playwrightService = createPlaywrightService();

    function collectDiagnostics(sessionId) {
        return sessionManager.getDiagnostics(sessionId);
    }

    function buildDiagnosticsPayload(sessionId, {includeConsole = false, includeNetworkErrors = false} = {}) {
        const diagnostics = collectDiagnostics(sessionId);
        return {
            consoleErrors: includeConsole ? diagnostics.consoleErrors : [],
            consoleWarnings: includeConsole ? diagnostics.consoleWarnings : [],
            consoleLogs: includeConsole ? diagnostics.consoleLogs : [],
            networkErrors: includeNetworkErrors ? diagnostics.networkErrors : [],
            ignoredNoiseCount: diagnostics.ignoredNoiseCount
        };
    }

    async function applyAuthMode({session, baseUrl, auth}) {
        if (!auth || auth.mode === "none") {
            return null;
        }

        if (auth.mode === "useExistingMcpAuth") {
            return authBridge.authFromApiLogin({
                session,
                baseUrl,
                useExistingMcpAuth: true,
                storageKey: auth.storageKey
            });
        }

        return authBridge.authFromApiLogin({
            session,
            baseUrl,
            login: auth.login,
            password: auth.password,
            storageKey: auth.storageKey
        });
    }

    function createAuthRedirectError({session, auth, requestedUrl}) {
        const finalUrl = session?.page?.url?.() || requestedUrl || session?.baseUrl || null;
        const authenticatedFlow = auth?.mode && auth.mode !== "none";
        return browserError(
            authenticatedFlow ? "AUTH_SESSION_EXPIRED" : "AUTH_REDIRECTED_TO_LOGIN",
            authenticatedFlow
                ? "Authenticated browser session appears expired or was rejected by the frontend."
                : "Frontend redirected the browser to the login page.",
            {
                url: finalUrl,
                finalUrl,
                meta: {
                    authMode: auth?.mode || "none",
                    requestedUrl
                }
            }
        );
    }

    async function ensureNotRedirectedToLogin({session, auth, requestedUrl}) {
        const finalUrl = session.page.url();
        if (isLoginUrl(finalUrl)) {
            throw createAuthRedirectError({session, auth, requestedUrl});
        }
    }

    async function navigateWithOptionalTargetWait({session, url, auth, targetSelector}) {
        try {
            const navigation = await playwrightService.navigate({session, url, waitUntil: "domcontentloaded"});
            await ensureNotRedirectedToLogin({session, auth, requestedUrl: url});

            if (targetSelector) {
                await playwrightService.waitFor({session, selector: targetSelector, state: "visible", timeoutMs: browserConfig.actionTimeoutMs});
            } else {
                await playwrightService.waitFor({session, waitUntil: "networkidle", timeoutMs: browserConfig.navigationTimeoutMs});
            }

            await ensureNotRedirectedToLogin({session, auth, requestedUrl: url});
            return navigation;
        } catch (error) {
            if (error?.code === "REDIRECTED_TO_LOGIN" || isLoginUrl(session?.page?.url?.())) {
                throw createAuthRedirectError({session, auth, requestedUrl: url});
            }

            throw error;
        }
    }

    async function runPageOpenWorkflow({baseUrl, path, device, headless, viewport, auth, defaultTargetSelector, targetSelector}) {
        let sessionId = null;
        let workflowSucceeded = false;

        try {
            const openedSession = await sessionManager.openSession({baseUrl, device, headless, viewport});
            sessionId = openedSession.sessionId;
            const session = sessionManager.getSession(sessionId);
            const authResult = await applyAuthMode({session, baseUrl, auth});
            const requestedUrl = new URL(path, baseUrl).toString();
            const resolvedTargetSelector = targetSelector || defaultTargetSelector || null;
            const navigation = await navigateWithOptionalTargetWait({session, url: requestedUrl, auth, targetSelector: resolvedTargetSelector});

            let target = null;
            if (resolvedTargetSelector) {
                const rectPayload = await playwrightService.getBoundingRect({
                    session,
                    selector: resolvedTargetSelector,
                    timeoutMs: browserConfig.actionTimeoutMs
                });
                target = {
                    selector: resolvedTargetSelector,
                    rect: rectPayload.rect
                };
            }

            const result = asToolResult({
                ok: true,
                sessionId,
                url: navigation.url,
                title: navigation.title,
                path,
                auth: authResult,
                target,
                ...buildDiagnosticsPayload(sessionId)
            });
            workflowSucceeded = true;
            return result;
        } catch (error) {
            const debug = await safelyCaptureDebugArtifacts({
                artifactService,
                sessionManager,
                sessionId,
                label: "browser-open-page-error"
            });
            return asToolResult(toBrowserErrorPayload(error, {
                debug,
                fallbackUrl: sessionId ? sessionManager.findSession(sessionId)?.page?.url?.() || baseUrl : baseUrl
            }));
        } finally {
            if (sessionId && !workflowSucceeded) {
                await sessionManager.closeSession(sessionId).catch(() => null);
            }
        }
    }

    async function runInspectWorkflow({
        baseUrl,
        url,
        device,
        headless,
        viewport,
        auth,
        targetSelector,
        captureStyles,
        captureConsole,
        captureNetworkErrors,
        takeFullPageScreenshot,
        takeElementScreenshot,
        styleProperties
    }) {
        let sessionId = null;

        try {
            const openedSession = await sessionManager.openSession({baseUrl, device, headless, viewport});
            sessionId = openedSession.sessionId;
            const session = sessionManager.getSession(sessionId);
            const authResult = await applyAuthMode({session, baseUrl, auth});
            const navigation = await navigateWithOptionalTargetWait({session, url, auth, targetSelector});

            const artifacts = {};
            let target = null;

            if (takeFullPageScreenshot) {
                const fullPagePath = await artifactService.resolveArtifactPath(sessionId, suggestedFileName("page-full"));
                await playwrightService.screenshot({session, type: "fullPage", path: fullPagePath});
                artifacts.fullPageScreenshot = fullPagePath;
            }

            if (targetSelector && takeElementScreenshot) {
                const elementPath = await artifactService.resolveArtifactPath(sessionId, suggestedFileName(targetSelector));
                await playwrightService.screenshot({
                    session,
                    type: "element",
                    selector: targetSelector,
                    path: elementPath,
                    timeoutMs: browserConfig.actionTimeoutMs
                });
                artifacts.elementScreenshot = elementPath;
            }

            if (targetSelector) {
                const rectPayload = await playwrightService.getBoundingRect({
                    session,
                    selector: targetSelector,
                    timeoutMs: browserConfig.actionTimeoutMs
                });
                target = {
                    selector: targetSelector,
                    rect: rectPayload.rect
                };
            }

            let computedStyles = null;
            if (targetSelector && captureStyles) {
                computedStyles = await playwrightService.getComputedStyles({
                    session,
                    selector: targetSelector,
                    includeParents: true,
                    stopAt: "body",
                    properties: styleProperties,
                    timeoutMs: browserConfig.actionTimeoutMs
                });
                artifacts.stylesJson = await artifactService.writeJson(
                    sessionId,
                    suggestedFileName("styles", ".json"),
                    computedStyles
                );
            }

            const diagnostics = buildDiagnosticsPayload(sessionId, {
                includeConsole: captureConsole,
                includeNetworkErrors: captureNetworkErrors
            });

            return asToolResult({
                ok: true,
                url: navigation.url,
                title: navigation.title,
                auth: authResult,
                artifacts,
                target,
                computedStyles: computedStyles?.chain || null,
                consoleErrors: diagnostics.consoleErrors,
                consoleWarnings: diagnostics.consoleWarnings,
                consoleLogs: diagnostics.consoleLogs,
                networkErrors: diagnostics.networkErrors,
                ignoredNoiseCount: diagnostics.ignoredNoiseCount
            });
        } catch (error) {
            const debug = await safelyCaptureDebugArtifacts({
                artifactService,
                sessionManager,
                sessionId,
                label: "browser-inspect-error"
            });
            return asToolResult(toBrowserErrorPayload(error, {
                debug,
                fallbackUrl: sessionId ? sessionManager.findSession(sessionId)?.page?.url?.() || url || baseUrl : url || baseUrl
            }));
        } finally {
            if (sessionId) {
                await sessionManager.closeSession(sessionId);
            }
        }
    }

    const registeredToolNames = [
        "browser_open_session",
        "browser_close_session",
        "browser_navigate",
        "browser_auth_from_api_login",
        "browser_open_profile_page",
        "browser_open_account_home",
        "browser_open_security_page",
        "browser_capture_profile_mobile",
        "browser_wait_for",
        "browser_click",
        "browser_fill",
        "browser_press",
        "browser_evaluate",
        "browser_get_text",
        "browser_get_attribute",
        "browser_screenshot",
        "browser_get_bounding_rect",
        "browser_get_computed_styles",
        "browser_assert_layout",
        "browser_save_storage_state",
        "browser_load_storage_state",
        "browser_get_console_logs",
        "browser_get_network_errors",
        "browser_inspect_page"
    ];

    function wrapTool(handler, {sessionIdKey = "sessionId", debugLabel = "browser-error"} = {}) {
        return async (input = {}) => {
            try {
                const payload = await handler(input);
                return asToolResult(payload);
            } catch (error) {
                const debug = await safelyCaptureDebugArtifacts({
                    artifactService,
                    sessionManager,
                    sessionId: input?.[sessionIdKey],
                    label: debugLabel
                });
                return asToolResult(toBrowserErrorPayload(error, {debug}));
            }
        };
    }

    server.registerTool(
        "browser_open_session",
        {
            description: "Create a stateful browser session backed by Playwright Chromium.",
            inputSchema: {
                baseUrl: z.string().url(),
                device: z.string().optional(),
                headless: z.boolean().optional(),
                viewport: viewportInputSchema.optional()
            }
        },
        wrapTool(async ({baseUrl, device, headless, viewport}) => ({
            ok: true,
            ...(await sessionManager.openSession({baseUrl, device, headless, viewport}))
        }), {sessionIdKey: null})
    );

    server.registerTool(
        "browser_close_session",
        {
            description: "Close a browser session and release Chromium resources.",
            inputSchema: {
                sessionId: z.string().min(1)
            }
        },
        wrapTool(async ({sessionId}) => {
            const closed = await sessionManager.closeSession(sessionId);
            if (!closed) {
                throw browserError("INVALID_SESSION_ID", `Unknown browser sessionId '${sessionId}'.`);
            }
            return {ok: true};
        }, {debugLabel: "browser-close-error"})
    );

    server.registerTool(
        "browser_navigate",
        {
            description: "Navigate the current browser page to an absolute or baseUrl-relative URL.",
            inputSchema: {
                sessionId: z.string().min(1),
                url: z.string().min(1),
                waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional()
            }
        },
        wrapTool(async ({sessionId, url, waitUntil}) => {
            const session = sessionManager.getSession(sessionId);
            return playwrightService.navigate({session, url, waitUntil});
        }, {debugLabel: "browser-navigate-error"})
    );

    server.registerTool(
        "browser_auth_from_api_login",
        {
            description: "Authenticate frontend state by API login and persist tokens into localStorage for the current browser origin.",
            inputSchema: {
                sessionId: z.string().min(1),
                baseUrl: z.string().url().optional(),
                login: z.string().min(1).optional(),
                password: z.string().min(1).optional(),
                useExistingMcpAuth: z.boolean().optional(),
                storageKey: z.string().min(1).optional()
            }
        },
        wrapTool(async ({sessionId, baseUrl, login, password, useExistingMcpAuth, storageKey}) => {
            const session = sessionManager.getSession(sessionId);
            return authBridge.authFromApiLogin({
                session,
                baseUrl,
                login,
                password,
                useExistingMcpAuth,
                storageKey
            });
        }, {debugLabel: "browser-auth-error"})
    );

    server.registerTool(
        "browser_wait_for",
        {
            description: "Wait for a selector, load state, or URL condition inside an existing browser session.",
            inputSchema: {
                sessionId: z.string().min(1),
                selector: z.string().min(1).optional(),
                state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
                waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional(),
                timeoutMs: z.number().int().positive().optional(),
                urlIncludes: z.string().min(1).optional(),
                urlMatches: z.string().min(1).optional()
            }
        },
        wrapTool(async ({sessionId, selector, state, waitUntil, timeoutMs, urlIncludes, urlMatches}) => {
            const session = sessionManager.getSession(sessionId);
            return playwrightService.waitFor({
                session,
                selector,
                state,
                waitUntil,
                timeoutMs,
                urlIncludes,
                urlMatches
            });
        }, {debugLabel: "browser-wait-error"})
    );

    server.registerTool(
        "browser_click",
        {
            description: "Click an element in the current browser session.",
            inputSchema: {
                sessionId: z.string().min(1),
                selector: z.string().min(1),
                timeoutMs: z.number().int().positive().optional(),
                waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional(),
                button: z.enum(["left", "middle", "right"]).optional(),
                clickCount: z.number().int().positive().optional()
            }
        },
        wrapTool(async ({sessionId, selector, timeoutMs, waitUntil, button, clickCount}) => {
            const session = sessionManager.getSession(sessionId);
            return playwrightService.click({session, selector, timeoutMs, waitUntil, button, clickCount});
        }, {debugLabel: "browser-click-error"})
    );

    server.registerTool(
        "browser_fill",
        {
            description: "Fill an input, textarea, or contenteditable-compatible field.",
            inputSchema: {
                sessionId: z.string().min(1),
                selector: z.string().min(1),
                value: z.union([z.string(), z.number(), z.boolean()]),
                timeoutMs: z.number().int().positive().optional()
            }
        },
        wrapTool(async ({sessionId, selector, value, timeoutMs}) => {
            const session = sessionManager.getSession(sessionId);
            return playwrightService.fill({session, selector, value, timeoutMs});
        }, {debugLabel: "browser-fill-error"})
    );

    server.registerTool(
        "browser_press",
        {
            description: "Press a keyboard key on the page or a focused selector.",
            inputSchema: {
                sessionId: z.string().min(1),
                key: z.string().min(1),
                selector: z.string().min(1).optional(),
                timeoutMs: z.number().int().positive().optional(),
                waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional()
            }
        },
        wrapTool(async ({sessionId, key, selector, timeoutMs, waitUntil}) => {
            const session = sessionManager.getSession(sessionId);
            return playwrightService.press({session, key, selector, timeoutMs, waitUntil});
        }, {debugLabel: "browser-press-error"})
    );

    server.registerTool(
        "browser_evaluate",
        {
            description: "Evaluate a JavaScript expression in the page context and return a serializable result.",
            inputSchema: {
                sessionId: z.string().min(1),
                expression: z.string().min(1),
                arg: z.unknown().optional(),
                selector: z.string().min(1).optional(),
                timeoutMs: z.number().int().positive().optional()
            }
        },
        wrapTool(async ({sessionId, expression, arg, selector, timeoutMs}) => {
            const session = sessionManager.getSession(sessionId);
            return playwrightService.evaluate({session, expression, arg, selector, timeoutMs});
        }, {debugLabel: "browser-evaluate-error"})
    );

    server.registerTool(
        "browser_get_text",
        {
            description: "Return text content for a visible element.",
            inputSchema: {
                sessionId: z.string().min(1),
                selector: z.string().min(1),
                timeoutMs: z.number().int().positive().optional(),
                trim: z.boolean().optional()
            }
        },
        wrapTool(async ({sessionId, selector, timeoutMs, trim}) => {
            const session = sessionManager.getSession(sessionId);
            return playwrightService.getText({session, selector, timeoutMs, trim});
        }, {debugLabel: "browser-get-text-error"})
    );

    server.registerTool(
        "browser_get_attribute",
        {
            description: "Return an attribute value for a target element without failing when the attribute is absent.",
            inputSchema: {
                sessionId: z.string().min(1),
                selector: z.string().min(1),
                name: z.string().min(1),
                timeoutMs: z.number().int().positive().optional()
            }
        },
        wrapTool(async ({sessionId, selector, name, timeoutMs}) => {
            const session = sessionManager.getSession(sessionId);
            return playwrightService.getAttribute({session, selector, name, timeoutMs});
        }, {debugLabel: "browser-get-attribute-error"})
    );

    server.registerTool(
        "browser_screenshot",
        {
            description: "Capture a full-page or element screenshot and return the artifact path.",
            inputSchema: {
                sessionId: z.string().min(1),
                type: z.enum(["fullPage", "element"]),
                selector: z.string().min(1).optional(),
                fileName: z.string().min(1).optional()
            }
        },
        wrapTool(async ({sessionId, type, selector, fileName}) => {
            const session = sessionManager.getSession(sessionId);
            const resolvedFileName = fileName || (type === "fullPage"
                ? suggestedFileName("page-full")
                : suggestedFileName(selector || "element"));
            const path = await artifactService.resolveArtifactPath(sessionId, resolvedFileName);
            return playwrightService.screenshot({session, type, selector, path, timeoutMs: browserConfig.actionTimeoutMs});
        }, {debugLabel: "browser-screenshot-error"})
    );

    server.registerTool(
        "browser_get_bounding_rect",
        {
            description: "Return getBoundingClientRect() for a target element.",
            inputSchema: {
                sessionId: z.string().min(1),
                selector: z.string().min(1)
            }
        },
        wrapTool(async ({sessionId, selector}) => {
            const session = sessionManager.getSession(sessionId);
            return playwrightService.getBoundingRect({session, selector, timeoutMs: browserConfig.actionTimeoutMs});
        }, {debugLabel: "browser-bounding-rect-error"})
    );

    server.registerTool(
        "browser_get_computed_styles",
        {
            description: "Return computed styles for an element and optionally its parent chain.",
            inputSchema: {
                sessionId: z.string().min(1),
                selector: z.string().min(1),
                includeParents: z.boolean().optional(),
                stopAt: z.string().min(1).optional(),
                properties: z.array(z.string().min(1)).optional()
            }
        },
        wrapTool(async ({sessionId, selector, includeParents, stopAt, properties}) => {
            const session = sessionManager.getSession(sessionId);
            return playwrightService.getComputedStyles({
                session,
                selector,
                includeParents,
                stopAt,
                properties,
                timeoutMs: browserConfig.actionTimeoutMs
            });
        }, {debugLabel: "browser-computed-styles-error"})
    );

    server.registerTool(
        "browser_assert_layout",
        {
            description: "Run numeric layout assertions against getBoundingClientRect() for a target element.",
            inputSchema: {
                sessionId: z.string().min(1),
                selector: z.string().min(1),
                timeoutMs: z.number().int().positive().optional(),
                assertions: layoutAssertionsSchema.optional(),
                presets: layoutPresetsSchema.optional()
            }
        },
        wrapTool(async ({sessionId, selector, assertions, presets, timeoutMs}) => {
            const session = sessionManager.getSession(sessionId);
            return playwrightService.assertLayout({session, selector, assertions, presets, timeoutMs});
        }, {debugLabel: "browser-assert-layout-error"})
    );

    server.registerTool(
        "browser_save_storage_state",
        {
            description: "Persist the current Playwright storage state to a runtime artifact JSON file.",
            inputSchema: {
                sessionId: z.string().min(1),
                fileName: z.string().min(1).optional()
            }
        },
        wrapTool(async ({sessionId, fileName}) => {
            const session = sessionManager.getSession(sessionId);
            const storagePayload = await playwrightService.saveStorageState({session});
            const resolvedFileName = fileName || suggestedFileName("storage-state", ".json");
            const path = await artifactService.writeJson(sessionId, resolvedFileName, storagePayload.storageState);

            return {
                ok: true,
                url: storagePayload.url,
                path,
                cookiesCount: storagePayload.cookiesCount,
                originsCount: storagePayload.originsCount
            };
        }, {debugLabel: "browser-save-storage-state-error"})
    );

    server.registerTool(
        "browser_load_storage_state",
        {
            description: "Load a Playwright storage state artifact JSON into the current browser session.",
            inputSchema: {
                sessionId: z.string().min(1),
                path: z.string().min(1)
            }
        },
        wrapTool(async ({sessionId, path}) => {
            const session = sessionManager.getSession(sessionId);
            const storageState = await artifactService.readJson(path);
            return playwrightService.loadStorageState({session, storageState});
        }, {debugLabel: "browser-load-storage-state-error"})
    );

    server.registerTool(
        "browser_get_console_logs",
        {
            description: "Return accumulated browser console logs for a session.",
            inputSchema: {
                sessionId: z.string().min(1)
            }
        },
        wrapTool(async ({sessionId}) => {
            sessionManager.getSession(sessionId);
            const diagnostics = collectDiagnostics(sessionId);
            return {
                ok: true,
                logs: diagnostics.consoleLogs,
                consoleErrors: diagnostics.consoleErrors,
                consoleWarnings: diagnostics.consoleWarnings,
                ignoredNoiseCount: diagnostics.ignoredNoiseCount
            };
        }, {debugLabel: "browser-console-logs-error"})
    );

    server.registerTool(
        "browser_get_network_errors",
        {
            description: "Return failed or HTTP 4xx/5xx network requests captured for a browser session.",
            inputSchema: {
                sessionId: z.string().min(1)
            }
        },
        wrapTool(async ({sessionId}) => {
            sessionManager.getSession(sessionId);
            const diagnostics = collectDiagnostics(sessionId);
            return {
                ok: true,
                requests: diagnostics.networkErrors,
                networkErrors: diagnostics.networkErrors,
                ignoredNoiseCount: diagnostics.ignoredNoiseCount
            };
        }, {debugLabel: "browser-network-errors-error"})
    );

    server.registerTool(
        "browser_open_profile_page",
        {
            description: "Open the authenticated profile page in a new browser session and keep the session alive for follow-up actions.",
            inputSchema: {
                baseUrl: z.string().url(),
                device: z.string().optional(),
                headless: z.boolean().optional(),
                viewport: viewportInputSchema.optional(),
                auth: authInputSchema.optional(),
                targetSelector: z.string().min(1).optional()
            }
        },
        async ({baseUrl, device, headless, viewport, auth, targetSelector}) => runPageOpenWorkflow({
            baseUrl,
            path: "/account/profile",
            device,
            headless,
            viewport,
            auth,
            defaultTargetSelector: ".profile-page",
            targetSelector
        })
    );

    server.registerTool(
        "browser_open_account_home",
        {
            description: "Open the authenticated account home page in a new browser session and keep the session alive for follow-up actions.",
            inputSchema: {
                baseUrl: z.string().url(),
                device: z.string().optional(),
                headless: z.boolean().optional(),
                viewport: viewportInputSchema.optional(),
                auth: authInputSchema.optional(),
                targetSelector: z.string().min(1).optional()
            }
        },
        async ({baseUrl, device, headless, viewport, auth, targetSelector}) => runPageOpenWorkflow({
            baseUrl,
            path: "/account",
            device,
            headless,
            viewport,
            auth,
            defaultTargetSelector: ".account-home",
            targetSelector
        })
    );

    server.registerTool(
        "browser_open_security_page",
        {
            description: "Open the authenticated security page in a new browser session and keep the session alive for follow-up actions.",
            inputSchema: {
                baseUrl: z.string().url(),
                device: z.string().optional(),
                headless: z.boolean().optional(),
                viewport: viewportInputSchema.optional(),
                auth: authInputSchema.optional(),
                targetSelector: z.string().min(1).optional()
            }
        },
        async ({baseUrl, device, headless, viewport, auth, targetSelector}) => runPageOpenWorkflow({
            baseUrl,
            path: "/account/security",
            device,
            headless,
            viewport,
            auth,
            defaultTargetSelector: ".security-page",
            targetSelector
        })
    );

    server.registerTool(
        "browser_capture_profile_mobile",
        {
            description: "Open the profile page in a mobile browser profile, capture screenshots/styles/diagnostics, and close the session.",
            inputSchema: {
                baseUrl: z.string().url(),
                headless: z.boolean().optional(),
                auth: authInputSchema.optional(),
                captureStyles: z.boolean().optional(),
                captureConsole: z.boolean().optional(),
                captureNetworkErrors: z.boolean().optional(),
                takeFullPageScreenshot: z.boolean().optional(),
                takeElementScreenshot: z.boolean().optional(),
                styleProperties: z.array(z.string().min(1)).optional()
            }
        },
        async ({
            baseUrl,
            headless,
            auth,
            captureStyles,
            captureConsole,
            captureNetworkErrors,
            takeFullPageScreenshot,
            takeElementScreenshot,
            styleProperties
        }) => runInspectWorkflow({
            baseUrl,
            url: new URL("/account/profile", baseUrl).toString(),
            device: "iPhone 14 Pro Max",
            headless,
            auth,
            targetSelector: ".profile-page",
            captureStyles: captureStyles ?? true,
            captureConsole: captureConsole ?? true,
            captureNetworkErrors: captureNetworkErrors ?? true,
            takeFullPageScreenshot: takeFullPageScreenshot ?? true,
            takeElementScreenshot: takeElementScreenshot ?? true,
            styleProperties
        })
    );

    server.registerTool(
        "browser_inspect_page",
        {
            description: "High-level frontend inspection workflow: open session, optionally auth, navigate, inspect, capture artifacts, and close session.",
            inputSchema: {
                baseUrl: z.string().url(),
                url: z.string().min(1),
                device: z.string().optional(),
                headless: z.boolean().optional(),
                viewport: viewportInputSchema.optional(),
                auth: authInputSchema.optional(),
                targetSelector: z.string().min(1).optional(),
                captureStyles: z.boolean().optional(),
                captureConsole: z.boolean().optional(),
                captureNetworkErrors: z.boolean().optional(),
                takeFullPageScreenshot: z.boolean().optional(),
                takeElementScreenshot: z.boolean().optional(),
                styleProperties: z.array(z.string().min(1)).optional()
            }
        },
        async ({
            baseUrl,
            url,
            device,
            headless,
            viewport,
            auth,
            targetSelector,
            captureStyles,
            captureConsole,
            captureNetworkErrors,
            takeFullPageScreenshot,
            takeElementScreenshot,
            styleProperties
        }) => runInspectWorkflow({
            baseUrl,
            url,
            device,
            headless,
            viewport,
            auth,
            targetSelector,
            captureStyles,
            captureConsole,
            captureNetworkErrors,
            takeFullPageScreenshot,
            takeElementScreenshot,
            styleProperties
        })
    );

    return {
        registeredToolNames,
        diagnostics: {
            supportedDevices: sessionManager.supportedDevices,
            artifactsDir: browserConfig.artifactsDir,
            sharedAuthSession: Boolean(sharedAuthSession)
        },
        browserServices: {
            sessionManager,
            artifactService,
            authBridge,
            playwrightService
        }
    };
}

