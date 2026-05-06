import {getErrorMessage} from "../../utils/errors.js";
import {browserError} from "./browser-errors.js";

function resolveOrigin(baseUrl) {
    try {
        return new URL(baseUrl).origin;
    } catch {
        throw browserError("INVALID_BASE_URL", `Invalid baseUrl '${baseUrl}'. Expected an absolute URL.`);
    }
}

export function createBrowserAuthBridge({sharedAuthSession, fallbackAuthSession, defaultStorageKey}) {
    function getSharedTokens() {
        return sharedAuthSession?.getTokens?.() || null;
    }

    function hasValidSharedAuth() {
        return Boolean(getSharedTokens()?.accessToken);
    }

    async function persistAuthState({session, origin, resolvedStorageKey, authState}) {
        await session.page.goto(origin, {waitUntil: "domcontentloaded"});
        await session.context.addInitScript(({key, value}) => {
            window.localStorage.setItem(key, JSON.stringify(value));
        }, {key: resolvedStorageKey, value: authState});
        await session.page.evaluate(({key, value}) => {
            window.localStorage.setItem(key, JSON.stringify(value));
        }, {key: resolvedStorageKey, value: authState});
        await session.page.reload({waitUntil: "domcontentloaded"});
    }

    async function authFromApiLogin({session, baseUrl, login, password, useExistingMcpAuth = false, storageKey}) {
        const origin = resolveOrigin(baseUrl || session.baseUrl);
        const resolvedStorageKey = String(storageKey || defaultStorageKey || "auth").trim();
        const authSession = sharedAuthSession || fallbackAuthSession;
        const hasSharedAuth = hasValidSharedAuth();

        if (!authSession) {
            throw browserError("AUTH_UNAVAILABLE", "Browser auth bridge is unavailable because MCP auth session is not configured.");
        }

        let tokens = null;
        let authMode = "api-token-localstorage";
        let didFallbackToExistingMcpAuth = false;

        if (useExistingMcpAuth) {
            tokens = getSharedTokens();
            if (!tokens?.accessToken) {
                throw browserError("MCP_AUTH_REQUIRED", "No active MCP auth token found. Call auth_login first or use browser_auth_from_api_login with credentials.");
            }
            authMode = "existing-mcp-auth";
        } else {
            try {
                await authSession.login({login, password, baseUrlOverride: origin});
                tokens = authSession.getTokens();
            } catch (error) {
                if (hasSharedAuth) {
                    tokens = getSharedTokens();
                    authMode = "existing-mcp-auth";
                    didFallbackToExistingMcpAuth = true;
                } else {
                    throw browserError("AUTH_API_LOGIN_FAILED", "Unable to authenticate browser session via API login.", {
                        url: session.page?.url?.() || origin,
                        finalUrl: session.page?.url?.() || origin,
                        meta: {
                            usedExistingMcpAuthFallback: false,
                            reason: getErrorMessage(error)
                        }
                    });
                }
            }
        }

        if (!tokens?.accessToken) {
            throw browserError("AUTH_API_LOGIN_FAILED", "API login did not yield an access token.", {
                url: session.page?.url?.() || origin,
                finalUrl: session.page?.url?.() || origin,
                meta: {
                    usedExistingMcpAuthFallback: didFallbackToExistingMcpAuth
                }
            });
        }

        const authState = {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken || null,
            user: null
        };

        await persistAuthState({session, origin, resolvedStorageKey, authState});

        return {
            ok: true,
            authMode,
            origin,
            storageKey: resolvedStorageKey,
            finalUrl: session.page.url(),
            usedExistingMcpAuth: authMode === "existing-mcp-auth",
            didFallbackToExistingMcpAuth
        };
    }

    return {
        authFromApiLogin
    };
}

