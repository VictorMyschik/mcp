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
    async function writeLocalStorageValue({page, key, value}) {
        await page.evaluate(({storageKey, storageValue}) => {
            window.localStorage.setItem(storageKey, JSON.stringify(storageValue));
        }, {
            storageKey: key,
            storageValue: value
        });
    }

    async function persistLocalStorageValue({
        session,
        origin,
        key,
        value,
        reloadPage = false,
        navigateToOrigin = false,
        persistInitScript = true
    }) {
        const resolvedOrigin = resolveOrigin(origin || session.baseUrl);
        const resolvedKey = String(key || "").trim();
        if (!resolvedKey) {
            throw browserError("INVALID_LOCAL_STORAGE_KEY", "localStorage key must be a non-empty string.");
        }

        if (persistInitScript) {
            await session.context.addInitScript(({storageKey, storageValue}) => {
                window.localStorage.setItem(storageKey, JSON.stringify(storageValue));
            }, {
                storageKey: resolvedKey,
                storageValue: value
            });
        }

        const currentUrl = session.page?.url?.() || "";
        const currentOrigin = currentUrl ? resolveOrigin(currentUrl) : null;
        const currentPageMatchesOrigin = currentOrigin === resolvedOrigin;
        let usedTemporaryPage = false;

        if (currentPageMatchesOrigin) {
            await writeLocalStorageValue({page: session.page, key: resolvedKey, value});
        } else {
            const tempPage = await session.context.newPage();
            usedTemporaryPage = true;
            try {
                await tempPage.goto(resolvedOrigin, {waitUntil: "domcontentloaded"});
                await writeLocalStorageValue({page: tempPage, key: resolvedKey, value});
            } finally {
                await tempPage.close().catch(() => null);
            }
        }

        let reloaded = false;
        let navigated = false;
        if (navigateToOrigin && !currentPageMatchesOrigin) {
            await session.page.goto(resolvedOrigin, {waitUntil: "domcontentloaded"});
            navigated = true;
        }

        if (reloadPage && (currentPageMatchesOrigin || navigateToOrigin)) {
            await session.page.reload({waitUntil: "domcontentloaded"});
            reloaded = true;
        }

        return {
            ok: true,
            origin: resolvedOrigin,
            key: resolvedKey,
            currentUrl: session.page?.url?.() || resolvedOrigin,
            currentPageMatchesOrigin,
            persistInitScript,
            usedTemporaryPage,
            navigated,
            reloaded
        };
    }

    async function seedAuthState({
        session,
        origin,
        storageKey,
        accessToken,
        refreshToken,
        user = null,
        extra = {},
        reloadPage = false,
        navigateToOrigin = false,
        persistInitScript = true
    }) {
        const resolvedStorageKey = String(storageKey || defaultStorageKey || "auth").trim();
        const resolvedAccessToken = String(accessToken || "").trim();
        if (!resolvedAccessToken) {
            throw browserError("INVALID_AUTH_STATE", "seedAuthState requires a non-empty accessToken.");
        }

        const authState = {
            accessToken: resolvedAccessToken,
            refreshToken: refreshToken ?? null,
            user: user ?? null,
            ...(extra && typeof extra === "object" ? extra : {})
        };

        const persisted = await persistLocalStorageValue({
            session,
            origin,
            key: resolvedStorageKey,
            value: authState,
            reloadPage,
            navigateToOrigin,
            persistInitScript
        });

        return {
            ...persisted,
            storageKey: resolvedStorageKey,
            authState
        };
    }

    function getSharedTokens() {
        return sharedAuthSession?.getTokens?.() || null;
    }

    function hasValidSharedAuth() {
        return Boolean(getSharedTokens()?.accessToken);
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

        const persisted = await persistLocalStorageValue({
            session,
            origin,
            key: resolvedStorageKey,
            value: authState,
            reloadPage: true,
            navigateToOrigin: true,
            persistInitScript: true
        });

        return {
            ...persisted,
            authMode,
            origin,
            storageKey: resolvedStorageKey,
            finalUrl: session.page.url(),
            usedExistingMcpAuth: authMode === "existing-mcp-auth",
            didFallbackToExistingMcpAuth
        };
    }

    return {
        authFromApiLogin,
        persistLocalStorageValue,
        seedAuthState
    };
}

