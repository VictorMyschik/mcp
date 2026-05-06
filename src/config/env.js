import path from "node:path";

function toPort(value, fallback) {
    const port = Number(value);
    return Number.isFinite(port) ? port : fallback;
}

function toPositiveNumber(value, fallback, minimum = 1) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.max(minimum, parsed);
}

function toBoolean(value, fallback) {
    if (value === undefined || value === null || String(value).trim() === "") {
        return fallback;
    }

    const normalized = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
        return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
        return false;
    }

    return fallback;
}

const REQUIRED_ENV_BY_TOOL = {
    sql: ["DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME"],
    swagger: ["SWAGGER_URL"],
    browser: []
};

function getMissingEnvVars(keys, env) {
    return keys.filter((key) => {
        const value = env[key];
        return value === undefined || value === null || String(value).trim() === "";
    });
}

export function getConfigFromEnv(env = process.env) {
    const sqlMissingVars = getMissingEnvVars(REQUIRED_ENV_BY_TOOL.sql, env);
    const swaggerMissingVars = getMissingEnvVars(REQUIRED_ENV_BY_TOOL.swagger, env);
    const browserMissingVars = getMissingEnvVars(REQUIRED_ENV_BY_TOOL.browser, env);

    return {
        db: {
            host: env.DB_HOST,
            port: toPort(env.DB_PORT, undefined),
            user: env.DB_USER,
            password: env.DB_PASSWORD,
            database: env.DB_NAME
        },
        swaggerUrl: env.SWAGGER_URL,
        api: {
            requestTimeoutMs: Math.max(1000, Number(env.API_REQUEST_TIMEOUT_MS || 15000)),
            retryOnUnauthorized: toBoolean(env.API_RETRY_ON_UNAUTHORIZED, true)
        },
        auth: {
            loginPath: String(env.AUTH_LOGIN_PATH || "/api/v1/login").trim(),
            loginMethod: String(env.AUTH_LOGIN_METHOD || "post").trim().toLowerCase(),
            usernameField: String(env.AUTH_USERNAME_FIELD || "login").trim(),
            passwordField: String(env.AUTH_PASSWORD_FIELD || "password").trim(),
            tokenFieldPath: String(env.AUTH_TOKEN_FIELD_PATH || "content.accessToken").trim(),
            refreshTokenFieldPath: String(env.AUTH_REFRESH_TOKEN_FIELD_PATH || "content.refreshToken").trim(),
            tokenTypeFieldPath: String(env.AUTH_TOKEN_TYPE_FIELD_PATH || "content.tokenType").trim(),
            defaultTokenType: String(env.AUTH_DEFAULT_TOKEN_TYPE || "Bearer").trim(),
            staticToken: String(env.AUTH_TOKEN || "").trim(),
            staticRefreshToken: String(env.AUTH_REFRESH_TOKEN || "").trim(),
            username: String(env.AUTH_USERNAME || "").trim(),
            password: String(env.AUTH_PASSWORD || "").trim(),
            autoLogin: toBoolean(env.AUTH_AUTO_LOGIN, true)
        },
        tools: {
            sql: {
                enabled: sqlMissingVars.length === 0,
                missingEnvVars: sqlMissingVars
            },
            swagger: {
                enabled: swaggerMissingVars.length === 0,
                missingEnvVars: swaggerMissingVars
            },
            browser: {
                enabled: browserMissingVars.length === 0 && toBoolean(env.BROWSER_TOOLS_ENABLED, true),
                missingEnvVars: browserMissingVars
            }
        },
        browser: {
            headlessDefault: toBoolean(env.BROWSER_HEADLESS_DEFAULT, true),
            sessionTtlMs: toPositiveNumber(env.BROWSER_SESSION_TTL_MS, 10 * 60 * 1000),
            cleanupIntervalMs: toPositiveNumber(env.BROWSER_CLEANUP_INTERVAL_MS, 60 * 1000),
            navigationTimeoutMs: toPositiveNumber(env.BROWSER_NAVIGATION_TIMEOUT_MS, 30 * 1000),
            actionTimeoutMs: toPositiveNumber(env.BROWSER_ACTION_TIMEOUT_MS, 30 * 1000),
            maxConsoleEntries: toPositiveNumber(env.BROWSER_MAX_CONSOLE_ENTRIES, 200),
            maxNetworkErrors: toPositiveNumber(env.BROWSER_MAX_NETWORK_ERRORS, 200),
            frontendAuthStorageKey: String(env.FRONTEND_AUTH_STORAGE_KEY || "auth").trim(),
            artifactsDir: path.resolve(process.cwd(), String(env.BROWSER_ARTIFACTS_DIR || "artifacts/browser").trim())
        }
    };
}

export const config = getConfigFromEnv();

