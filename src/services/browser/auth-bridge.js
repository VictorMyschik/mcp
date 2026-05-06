import {browserError} from "./browser-errors.js";

function resolveOrigin(baseUrl) {
    try {
        return new URL(baseUrl).origin;
    } catch {
        throw browserError("INVALID_BASE_URL", `Invalid baseUrl '${baseUrl}'. Expected an absolute URL.`);
    }
}

export function createBrowserAuthBridge({sharedAuthSession, fallbackAuthSession, defaultStorageKey}) {
    async function authFromApiLogin({session, baseUrl, login, password, useExistingMcpAuth = false, storageKey}) {
        const origin = resolveOrigin(baseUrl || session.baseUrl);
        const resolvedStorageKey = String(storageKey || defaultStorageKey || "auth").trim();
        const authSession = sharedAuthSession || fallbackAuthSession;

        if (!authSession) {
            throw browserError("AUTH_UNAVAILABLE", "Browser auth bridge is unavailable because MCP auth session is not configured.");
        }

        if (useExistingMcpAuth) {
            const existingTokens = sharedAuthSession?.getTokens?.();
            if (!existingTokens?.accessToken) {
                throw browserError("MCP_AUTH_REQUIRED", "No active MCP auth token found. Call auth_login first or use browser_auth_from_api_login with credentials.");
            }
        } else {
            await authSession.login({login, password, baseUrlOverride: origin});
        }

        const tokens = authSession.getTokens();
        if (!tokens?.accessToken) {
            throw browserError("API_LOGIN_UNAVAILABLE", "API login did not yield an access token.");
        }

        const authState = {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken || null,
            user: null
        };

        await session.page.goto(origin, {waitUntil: "domcontentloaded"});
        await session.context.addInitScript(({key, value}) => {
            window.localStorage.setItem(key, JSON.stringify(value));
        }, {key: resolvedStorageKey, value: authState});
        await session.page.evaluate(({key, value}) => {
            window.localStorage.setItem(key, JSON.stringify(value));
        }, {key: resolvedStorageKey, value: authState});
        await session.page.reload({waitUntil: "domcontentloaded"});

        return {
            ok: true,
            authMode: "api-token-localstorage",
            origin,
            storageKey: resolvedStorageKey
        };
    }

    return {
        authFromApiLogin
    };
}

