import {chromium, devices} from "playwright";

import {browserError} from "./browser-errors.js";

const DESKTOP_CHROME_PRESET = {
    viewport: {width: 1440, height: 900},
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false
};

const DEVICE_PRESETS = {
    "Desktop Chrome": DESKTOP_CHROME_PRESET,
    "iPhone 12": devices["iPhone 12"],
    "iPhone 14 Pro Max": devices["iPhone 14 Pro Max"]
};

const DEV_CONSOLE_NOISE_PATTERNS = [
    /^\[vite\]/i,
    /vite connected/i,
    /vite connecting/i,
    /download the react devtools/i,
    /install the vue devtools/i,
    /lit is in dev mode/i,
    /react router future flag warning/i
];

const CONSOLE_WARNING_TYPES = new Set(["warn", "warning"]);
const CONSOLE_ERROR_TYPES = new Set(["error", "pageerror"]);

function limitSize(list, maxSize) {
    if (list.length > maxSize) {
        list.splice(0, list.length - maxSize);
    }
}

function pickContextOptions(descriptor = {}) {
    const {
        viewport,
        userAgent,
        screen,
        deviceScaleFactor,
        isMobile,
        hasTouch,
        locale,
        colorScheme,
        timezoneId
    } = descriptor;

    return {
        ...(viewport ? {viewport} : {}),
        ...(userAgent ? {userAgent} : {}),
        ...(screen ? {screen} : {}),
        ...(deviceScaleFactor !== undefined ? {deviceScaleFactor} : {}),
        ...(isMobile !== undefined ? {isMobile} : {}),
        ...(hasTouch !== undefined ? {hasTouch} : {}),
        ...(locale ? {locale} : {}),
        ...(colorScheme ? {colorScheme} : {}),
        ...(timezoneId ? {timezoneId} : {})
    };
}

function toSerializableConsoleMessage(message) {
    const location = message.location?.();
    return {
        type: message.type(),
        text: message.text(),
        location: location?.url
            ? `${location.url}${location.lineNumber ? `:${location.lineNumber}` : ""}${location.columnNumber ? `:${location.columnNumber}` : ""}`
            : null,
        timestamp: new Date().toISOString()
    };
}

function normalizeNetworkError(record) {
    return {
        url: record.url,
        status: record.status ?? null,
        method: record.method,
        resourceType: record.resourceType,
        errorText: record.errorText ?? null,
        timestamp: new Date().toISOString()
    };
}

function isIgnoredConsoleNoise(entry) {
    if (!entry?.text) {
        return false;
    }

    if (CONSOLE_ERROR_TYPES.has(entry.type)) {
        return false;
    }

    return DEV_CONSOLE_NOISE_PATTERNS.some((pattern) => pattern.test(entry.text));
}

function isIgnoredNetworkNoise(entry) {
    const errorText = String(entry?.errorText || "").toLowerCase();
    return errorText.includes("net::err_aborted");
}

function buildDiagnosticsSnapshot(session) {
    const consoleLogs = [...session.consoleLogs];
    return {
        consoleLogs,
        consoleErrors: consoleLogs.filter((entry) => CONSOLE_ERROR_TYPES.has(entry.type)),
        consoleWarnings: consoleLogs.filter((entry) => CONSOLE_WARNING_TYPES.has(entry.type)),
        networkErrors: [...session.networkErrors],
        ignoredNoiseCount: Number(session.ignoredNoiseCount || 0)
    };
}

export const SUPPORTED_BROWSER_DEVICES = Object.keys(DEVICE_PRESETS).sort((left, right) => left.localeCompare(right));

export function createBrowserSessionManager({
    headlessDefault,
    sessionTtlMs,
    cleanupIntervalMs,
    navigationTimeoutMs,
    actionTimeoutMs,
    maxConsoleEntries,
    maxNetworkErrors
}) {
    const sessions = new Map();
    let sequence = 0;

    const cleanupTimer = setInterval(() => {
        void cleanupExpiredSessions();
    }, cleanupIntervalMs);
    cleanupTimer.unref?.();

    function nextSessionId() {
        sequence += 1;
        return `browser-session-${String(sequence).padStart(3, "0")}`;
    }

    function touch(session) {
        session.lastUsedAt = Date.now();
        return session;
    }

    function buildContextOptions({baseUrl, device, viewport}) {
        if (device && !DEVICE_PRESETS[device]) {
            throw browserError("UNSUPPORTED_DEVICE", `Unsupported browser device preset '${device}'.`, {
                meta: {supportedDevices: SUPPORTED_BROWSER_DEVICES}
            });
        }

        const descriptor = device ? pickContextOptions(DEVICE_PRESETS[device]) : {};
        const contextOptions = {
            ignoreHTTPSErrors: true,
            baseURL: baseUrl,
            ...descriptor
        };

        if (viewport) {
            contextOptions.viewport = viewport;
            contextOptions.screen = viewport;
        }

        return contextOptions;
    }

    function attachObservers(session) {
        const {page} = session;

        page.on("console", (message) => {
            const entry = toSerializableConsoleMessage(message);
            if (isIgnoredConsoleNoise(entry)) {
                session.ignoredNoiseCount += 1;
                return;
            }

            session.consoleLogs.push(entry);
            limitSize(session.consoleLogs, maxConsoleEntries);
        });

        page.on("pageerror", (error) => {
            session.consoleLogs.push({
                type: "pageerror",
                text: error?.message || String(error),
                location: null,
                timestamp: new Date().toISOString()
            });
            limitSize(session.consoleLogs, maxConsoleEntries);
        });

        page.on("requestfailed", (request) => {
            const entry = normalizeNetworkError({
                url: request.url(),
                method: request.method(),
                resourceType: request.resourceType(),
                errorText: request.failure()?.errorText || "Request failed"
            });

            if (isIgnoredNetworkNoise(entry)) {
                session.ignoredNoiseCount += 1;
                return;
            }

            session.networkErrors.push(entry);
            limitSize(session.networkErrors, maxNetworkErrors);
        });

        page.on("response", (response) => {
            if (response.status() < 400) {
                return;
            }

            const request = response.request();
            session.networkErrors.push(normalizeNetworkError({
                url: response.url(),
                status: response.status(),
                method: request.method(),
                resourceType: request.resourceType()
            }));
            limitSize(session.networkErrors, maxNetworkErrors);
        });

        page.on("crash", () => {
            session.crashed = true;
        });

        page.on("close", () => {
            session.pageClosed = true;
        });
    }

    async function openSession({baseUrl, device, headless, viewport}) {
        const sessionId = nextSessionId();
        const browser = await chromium.launch({headless: headless ?? headlessDefault});
        const context = await browser.newContext(buildContextOptions({baseUrl, device, viewport}));
        const page = await context.newPage();
        page.setDefaultNavigationTimeout(navigationTimeoutMs);
        page.setDefaultTimeout(actionTimeoutMs);

        const session = {
            sessionId,
            baseUrl,
            device: device || null,
            browser,
            context,
            page,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            crashed: false,
            pageClosed: false,
            consoleLogs: [],
            networkErrors: [],
            ignoredNoiseCount: 0
        };

        attachObservers(session);
        sessions.set(sessionId, session);

        return {
            sessionId,
            baseUrl,
            device: session.device
        };
    }

    function findSession(sessionId) {
        return sessions.get(String(sessionId || "").trim()) || null;
    }

    function getSession(sessionId) {
        const session = findSession(sessionId);
        if (!session) {
            throw browserError("INVALID_SESSION_ID", `Unknown browser sessionId '${sessionId}'.`);
        }
        if (session.crashed) {
            throw browserError("BROWSER_CRASHED", `Browser session '${sessionId}' has crashed.`, {
                url: session.page?.url?.() || null
            });
        }
        if (session.pageClosed) {
            throw browserError("BROWSER_PAGE_CLOSED", `Browser page for session '${sessionId}' is already closed.`);
        }

        return touch(session);
    }

    function getDiagnostics(sessionId) {
        return buildDiagnosticsSnapshot(getSession(sessionId));
    }

    async function closeSession(sessionId) {
        const session = findSession(sessionId);
        if (!session) {
            return false;
        }

        sessions.delete(sessionId);

        await session.page?.close().catch(() => null);
        await session.context?.close().catch(() => null);
        await session.browser?.close().catch(() => null);
        return true;
    }

    async function cleanupExpiredSessions() {
        const now = Date.now();
        const expiredSessionIds = [...sessions.values()]
            .filter((session) => now - session.lastUsedAt >= sessionTtlMs)
            .map((session) => session.sessionId);

        for (const sessionId of expiredSessionIds) {
            await closeSession(sessionId);
        }
    }

    async function closeAll() {
        for (const sessionId of [...sessions.keys()]) {
            await closeSession(sessionId);
        }
    }

    function listSessions() {
        return [...sessions.values()].map((session) => ({
            sessionId: session.sessionId,
            baseUrl: session.baseUrl,
            device: session.device,
            createdAt: new Date(session.createdAt).toISOString(),
            lastUsedAt: new Date(session.lastUsedAt).toISOString()
        }));
    }

    return {
        openSession,
        getSession,
        findSession,
        closeSession,
        closeAll,
        listSessions,
        getDiagnostics,
        supportedDevices: SUPPORTED_BROWSER_DEVICES
    };
}

