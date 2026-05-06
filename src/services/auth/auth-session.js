import {getErrorMessage} from "../../utils/errors.js";

function getByPath(input, path) {
    if (!path) {
        return undefined;
    }

    return path.split(".").reduce((value, key) => {
        if (value === null || value === undefined || typeof value !== "object") {
            return undefined;
        }
        return value[key];
    }, input);
}

async function parseJsonOrText(response) {
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const text = await response.text();
    if (!text) {
        return null;
    }

    if (contentType.includes("application/json")) {
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }

    return text;
}

export function createAuthSession({authConfig, fetchImpl, buildBaseUrl, timeoutMs}) {
    let token = authConfig.staticToken || null;
    let tokenType = authConfig.defaultTokenType || "Bearer";
    let lastUsername = authConfig.username || null;
    let lastPassword = authConfig.password || null;

    function getAuthorizationHeader() {
        if (!token) {
            return null;
        }
        return `${tokenType} ${token}`.trim();
    }

    function clearAuth() {
        token = null;
        tokenType = authConfig.defaultTokenType || "Bearer";
    }

    function getState() {
        return {
            authenticated: Boolean(token),
            tokenType,
            hasStoredCredentials: Boolean(lastUsername && lastPassword),
            source: authConfig.staticToken ? "env_token" : "session"
        };
    }

    async function login({username, login, password} = {}) {
        const resolvedUsername = String(login || username || lastUsername || "").trim();
        const resolvedPassword = String(password || lastPassword || "").trim();
        if (!resolvedUsername || !resolvedPassword) {
            throw new Error("Missing credentials. Provide login/password (or username/password) or set AUTH_USERNAME and AUTH_PASSWORD.");
        }

        const baseUrl = buildBaseUrl();
        const url = new URL(authConfig.loginPath, baseUrl);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetchImpl(url.toString(), {
                method: String(authConfig.loginMethod || "post").toUpperCase(),
                headers: {
                    accept: "application/json",
                    "content-type": "application/json"
                },
                body: JSON.stringify({
                    [authConfig.usernameField]: resolvedUsername,
                    [authConfig.passwordField]: resolvedPassword
                }),
                signal: controller.signal
            });

            const payload = await parseJsonOrText(response);
            if (!response.ok) {
                throw new Error(`Login failed with ${response.status}: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
            }

            const extractedToken = getByPath(payload, authConfig.tokenFieldPath);
            if (!extractedToken || typeof extractedToken !== "string") {
                throw new Error(`Login response missing token at path '${authConfig.tokenFieldPath}'.`);
            }

            token = extractedToken;
            const extractedType = getByPath(payload, authConfig.tokenTypeFieldPath);
            tokenType = typeof extractedType === "string" && extractedType.trim()
                ? extractedType.trim()
                : authConfig.defaultTokenType || "Bearer";
            lastUsername = resolvedUsername;
            lastPassword = resolvedPassword;

            return {
                authenticated: true,
                tokenType
            };
        } catch (error) {
            throw new Error(`Unable to login: ${getErrorMessage(error)}`);
        } finally {
            clearTimeout(timeout);
        }
    }

    async function ensureAuthenticated() {
        if (token) {
            return true;
        }
        if (!authConfig.autoLogin) {
            return false;
        }

        await login();
        return true;
    }

    return {
        getAuthorizationHeader,
        getState,
        login,
        clearAuth,
        ensureAuthenticated
    };
}

