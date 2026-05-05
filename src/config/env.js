function toPort(value, fallback) {
    const port = Number(value);
    return Number.isFinite(port) ? port : fallback;
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

