function toPort(value, fallback) {
    const port = Number(value);
    return Number.isFinite(port) ? port : fallback;
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
    swagger: ["SWAGGER_URL"]
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
            tokenTypeFieldPath: String(env.AUTH_TOKEN_TYPE_FIELD_PATH || "content.tokenType").trim(),
            defaultTokenType: String(env.AUTH_DEFAULT_TOKEN_TYPE || "Bearer").trim(),
            staticToken: String(env.AUTH_TOKEN || "").trim(),
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
            }
        }
    };
}

export const config = getConfigFromEnv();

