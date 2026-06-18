import path from "node:path";
import {existsSync, readFileSync} from "node:fs";

import dotenv from "dotenv";

import {resolveMonitoringPaths} from "../services/monitoring/latency-report-service.js";
import {resolveOutventoRoot} from "../services/monitoring/resolve-outvento-root.js";
import {parseVitourBaseUrl, resolveVitourRoot} from "../services/vitour/vitour-paths.js";

export const ENV_SOURCE_PRIORITY = ["process.env", ".env.local", ".env"];
export const INTERNAL_API_TOKEN_ENV_PRIORITY = [
    "INTERNAL_API_TOKEN",
    "AUTH_TOKEN"
];
export const INTERNAL_API_TOKEN_TYPE_ENV_PRIORITY = [
    "INTERNAL_API_TOKEN_TYPE",
    "AUTH_DEFAULT_TOKEN_TYPE"
];

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

function getFirstNonEmptyValue(env, keys) {
    for (const key of keys) {
        const value = env?.[key];
        if (value === undefined || value === null || String(value).trim() === "") {
            continue;
        }

        return String(value).trim();
    }

    return "";
}

function resolveTlsRejectUnauthorized(env) {
    const explicitRejectUnauthorized = getFirstNonEmptyValue(env, [
        "API_TLS_REJECT_UNAUTHORIZED",
        "SWAGGER_TLS_REJECT_UNAUTHORIZED"
    ]);
    if (explicitRejectUnauthorized) {
        return toBoolean(explicitRejectUnauthorized, true);
    }

    const insecureSkipVerify = getFirstNonEmptyValue(env, [
        "API_TLS_INSECURE_SKIP_VERIFY",
        "SWAGGER_TLS_INSECURE_SKIP_VERIFY"
    ]);
    return !toBoolean(insecureSkipVerify, false);
}

const REQUIRED_ENV_BY_TOOL = {
    sql: ["DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "DB_NAME"],
    swagger: ["SWAGGER_URL"],
    browser: [],
    vitour: [],
    monitoring: [],
    qa: []
};

function getMissingEnvVars(keys, env) {
    return keys.filter((key) => {
        const value = env[key];
        return value === undefined || value === null || String(value).trim() === "";
    });
}

function parseEnvFile(filePath) {
    if (!existsSync(filePath)) {
        return {};
    }

    return dotenv.parse(readFileSync(filePath, "utf8"));
}

function getFirstNonEmptyEnvValue(env, keys, sourceByKey = {}) {
    for (const key of keys) {
        const value = env[key];
        if (value === undefined || value === null || String(value).trim() === "") {
            continue;
        }

        return {
            key,
            value: String(value).trim(),
            source: sourceByKey[key] || null
        };
    }

    return {
        key: null,
        value: "",
        source: null
    };
}

export function resolveWorkspaceEnv({cwd = process.cwd(), processEnv = process.env} = {}) {
    const envFile = path.resolve(cwd, ".env");
    const envLocalFile = path.resolve(cwd, ".env.local");
    const mergedEnv = {};
    const sourceByKey = {};
    const sources = [
        {name: ".env", values: parseEnvFile(envFile)},
        {name: ".env.local", values: parseEnvFile(envLocalFile)},
        {name: "process.env", values: processEnv || {}}
    ];

    for (const source of sources) {
        for (const [key, value] of Object.entries(source.values || {})) {
            if (value === undefined || value === null) {
                continue;
            }

            mergedEnv[key] = value;
            sourceByKey[key] = source.name;
        }
    }

    return {
        env: mergedEnv,
        sourceByKey
    };
}

export function getConfigFromEnv(env = process.env, {sourceByKey = {}, cwd = process.cwd()} = {}) {
    const sqlMissingVars = getMissingEnvVars(REQUIRED_ENV_BY_TOOL.sql, env);
    const swaggerMissingVars = getMissingEnvVars(REQUIRED_ENV_BY_TOOL.swagger, env);
    const browserMissingVars = getMissingEnvVars(REQUIRED_ENV_BY_TOOL.browser, env);
    const vitourMissingVars = getMissingEnvVars(REQUIRED_ENV_BY_TOOL.vitour, env);
    const monitoringMissingVars = getMissingEnvVars(REQUIRED_ENV_BY_TOOL.monitoring, env);
    const qaMissingVars = getMissingEnvVars(REQUIRED_ENV_BY_TOOL.qa, env);
    const outventoRoot = resolveOutventoRoot(env, {cwd});
    const monitoringPaths = resolveMonitoringPaths(env);
    const monitoringExplicitlyDisabled = toBoolean(env.MONITORING_TOOLS_ENABLED, true) === false;
    const monitoringReady = Boolean(outventoRoot) && existsSync(monitoringPaths.sshKeyPath);
    const vitourRoot = resolveVitourRoot(env, {cwd});
    const vitourPort = toPort(env.VITOUR_STATIC_PORT, 8765);
    const vitourHost = String(env.VITOUR_STATIC_HOST || "127.0.0.1").trim() || "127.0.0.1";
    const vitourBaseUrl = String(env.VITOUR_BASE_URL || `http://${vitourHost}:${vitourPort}`).trim();
    const parsedVitourBaseUrl = parseVitourBaseUrl(vitourBaseUrl);
    const vitourToolsExplicitlyDisabled = toBoolean(env.VITOUR_TOOLS_ENABLED, true) === false;
    const internalTranslationToken = getFirstNonEmptyEnvValue(env, INTERNAL_API_TOKEN_ENV_PRIORITY, sourceByKey);
    const internalTranslationTokenType = getFirstNonEmptyEnvValue(env, INTERNAL_API_TOKEN_TYPE_ENV_PRIORITY, sourceByKey);

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
            retryOnUnauthorized: toBoolean(env.API_RETRY_ON_UNAUTHORIZED, true),
            debug: toBoolean(env.API_DEBUG, false),
            tls: {
                rejectUnauthorized: resolveTlsRejectUnauthorized(env),
                caCertPath: getFirstNonEmptyValue(env, [
                    "API_TLS_CA_CERT_PATH",
                    "SWAGGER_TLS_CA_CERT_PATH"
                ]) || null
            }
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
            autoLogin: toBoolean(env.AUTH_AUTO_LOGIN, true),
            internalTranslations: {
                token: internalTranslationToken.value,
                tokenEnvVar: internalTranslationToken.key,
                tokenSource: internalTranslationToken.source,
                tokenEnvVarPriority: [...INTERNAL_API_TOKEN_ENV_PRIORITY],
                tokenType: String(internalTranslationTokenType.value || env.AUTH_DEFAULT_TOKEN_TYPE || "Bearer").trim() || "Bearer",
                tokenTypeEnvVar: internalTranslationTokenType.key,
                tokenTypeSource: internalTranslationTokenType.source,
                tokenTypeEnvVarPriority: [...INTERNAL_API_TOKEN_TYPE_ENV_PRIORITY]
            }
        },
        tools: {
            sql: {
                enabled: sqlMissingVars.length === 0,
                missingEnvVars: sqlMissingVars
            },
            swagger: {
                enabled: swaggerMissingVars.length === 0,
                missingEnvVars: swaggerMissingVars,
                generatedApiToolsEnabled: toBoolean(env.SWAGGER_GENERATED_API_TOOLS_ENABLED, true)
            },
            browser: {
                enabled: browserMissingVars.length === 0 && toBoolean(env.BROWSER_TOOLS_ENABLED, true),
                missingEnvVars: browserMissingVars
            },
            vitour: {
                enabled: Boolean(vitourRoot) && !vitourToolsExplicitlyDisabled && vitourMissingVars.length === 0,
                missingEnvVars: vitourMissingVars,
                disabledReason: !vitourRoot
                    ? "vitour_root_not_found"
                    : vitourToolsExplicitlyDisabled
                        ? "disabled_by_config"
                        : null
            },
            monitoring: {
                enabled: monitoringReady && !monitoringExplicitlyDisabled && monitoringMissingVars.length === 0,
                missingEnvVars: monitoringMissingVars,
                disabledReason: monitoringExplicitlyDisabled
                    ? "disabled_by_config"
                    : !outventoRoot
                        ? "outvento_root_not_found"
                        : !existsSync(monitoringPaths.sshKeyPath)
                            ? "ssh_key_not_found"
                            : null
            },
            qa: {
                enabled: qaMissingVars.length === 0 && toBoolean(env.QA_TOOLS_ENABLED, true),
                missingEnvVars: qaMissingVars
            }
        },
        monitoring: {
            outventoRoot,
            sshHost: monitoringPaths.sshHost,
            sshUser: monitoringPaths.sshUser,
            sshKeyPath: monitoringPaths.sshKeyPath
        },
        vitour: {
            root: vitourRoot,
            host: parsedVitourBaseUrl.host,
            port: parsedVitourBaseUrl.port,
            baseUrl: parsedVitourBaseUrl.baseUrl
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

const resolvedWorkspaceEnv = resolveWorkspaceEnv();

export const config = getConfigFromEnv(resolvedWorkspaceEnv.env, {
    sourceByKey: resolvedWorkspaceEnv.sourceByKey
});

