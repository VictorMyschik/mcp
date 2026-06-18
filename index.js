import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";

import {config} from "./src/config/env.js";
import {createLazyDbClient} from "./src/infrastructure/db/lazy-db-client.js";
import {createConfiguredFetch} from "./src/services/http/configured-fetch.js";
import {createSwaggerService} from "./src/services/swagger/swagger-cache.js";
import {createLatencyReportService} from "./src/services/monitoring/latency-report-service.js";
import {registerBrowserTools} from "./src/tools/register-browser-tools.js";
import {registerHealthTool} from "./src/tools/register-health-tool.js";
import {registerMonitoringTools} from "./src/tools/register-monitoring-tools.js";
import {registerStatusTool} from "./src/tools/register-status-tool.js";
import {registerSqlTools} from "./src/tools/register-sql-tools.js";
import {registerSwaggerTools} from "./src/tools/register-swagger-tools.js";
import {registerQaTools} from "./src/tools/register-qa-tools.js";
import {registerVitourTools} from "./src/tools/register-vitour-tools.js";

const server = new McpServer({
    name: "unified-mcp",
    version: "1.0.0"
});

const toolsByGroup = {
    sql: ["run_sql", "list_tables"],
    swagger: ["list_api_endpoints", "get_endpoint", "inspect_swagger_endpoint", "get_schema", "find_endpoint_by_keyword", "call_api_raw", "call_api_by_swagger", "auth_login", "auth_logout", "auth_status", "get_profile_page", "get_translations", "update_profile"],
    browser: ["browser_open_session", "browser_close_session", "browser_navigate", "browser_auth_from_api_login", "browser_set_local_storage", "browser_seed_auth_state", "browser_open_profile_page", "browser_open_account_home", "browser_open_security_page", "browser_capture_profile_mobile", "browser_wait_for", "browser_click", "browser_fill", "browser_set_input_files", "browser_press", "browser_evaluate", "browser_get_text", "browser_get_attribute", "browser_screenshot", "browser_get_bounding_rect", "browser_get_computed_styles", "browser_assert_layout", "browser_save_storage_state", "browser_load_storage_state", "browser_get_console_logs", "browser_get_network_errors", "browser_scan_i18n_leaks", "browser_inspect_page"],
    vitour: ["vitour_list_pages", "vitour_ensure_server", "vitour_read_snippet", "vitour_open_page", "vitour_inspect_page"],
    monitoring: ["monitoring_latency_report"],
    qa: ["qa_get_verification_code", "qa_list_recent_users", "qa_prepare_fixture_image"]
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectDbWithRetry(dbConfig, {maxRetries = 3, retryDelayMs = 1000} = {}) {
    const lazyClient = createLazyDbClient(dbConfig, {maxRetries, retryDelayMs});
    await lazyClient.connect();
    return lazyClient;
}

async function createSwaggerServiceWithRetry(options, {maxRetries = 3, retryDelayMs = 1000} = {}) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        try {
            const swaggerService = createSwaggerService(options);
            await swaggerService.loadSwagger({forceRefresh: true});
            return swaggerService;
        } catch (error) {
            lastError = error;
            if (attempt < maxRetries) {
                await sleep(retryDelayMs);
            }
        }
    }

    throw lastError;
}

const fetchImpl = createConfiguredFetch({
    tlsConfig: config.api.tls
});

let dbClient = null;
if (config.tools.sql.enabled) {
    try {
        dbClient = await connectDbWithRetry(config.db);
        registerSqlTools(server, {dbClient});
    } catch (error) {
        dbClient = null;
        config.tools.sql.enabled = false;
        config.tools.sql.runtimeError = error instanceof Error ? error.message : String(error);
        toolsByGroup.sql = [];
        console.warn(`SQL tools failed to register: ${config.tools.sql.runtimeError}`);
    }
} else {
    toolsByGroup.sql = [];
    console.warn(`SQL tools disabled. Missing env vars: ${config.tools.sql.missingEnvVars.join(", ")}`);
}

let swaggerService = null;
let sharedAuthSession = null;
let browserWorkflows = null;
if (config.tools.swagger.enabled) {
    try {
        swaggerService = await createSwaggerServiceWithRetry({
            swaggerUrl: config.swaggerUrl,
            fetchImpl
        });
        const {registeredToolNames = [], authSession} = await registerSwaggerTools(server, {
            swaggerService,
            authConfig: config.auth,
            apiConfig: config.api,
            generatedApiToolsEnabled: config.tools.swagger.generatedApiToolsEnabled,
            fetchImpl
        });
        toolsByGroup.swagger = registeredToolNames;
        sharedAuthSession = authSession;
    } catch (error) {
        swaggerService = null;
        config.tools.swagger.enabled = false;
        config.tools.swagger.runtimeError = error instanceof Error ? error.message : String(error);
        console.warn(`Swagger tools failed to register: ${config.tools.swagger.runtimeError}`);
    }
} else {
    console.warn(`Swagger tools disabled. Missing env vars: ${config.tools.swagger.missingEnvVars.join(", ")}`);
}

if (config.tools.browser.enabled) {
    try {
        const {registeredToolNames = [], browserWorkflows: workflows = null} = await registerBrowserTools(server, {
            browserConfig: config.browser,
            authConfig: config.auth,
            apiConfig: config.api,
            sharedAuthSession,
            fetchImpl,
            swaggerUrl: config.swaggerUrl
        });
        toolsByGroup.browser = registeredToolNames;
        browserWorkflows = workflows;
    } catch (error) {
        config.tools.browser.enabled = false;
        config.tools.browser.runtimeError = error instanceof Error ? error.message : String(error);
        console.warn(`Browser tools failed to register: ${config.tools.browser.runtimeError}`);
    }
}

if (config.tools.vitour.enabled) {
    try {
        const {registeredToolNames = []} = registerVitourTools(server, {
            vitourConfig: config.vitour,
            browserWorkflows,
            fetchImpl
        });
        toolsByGroup.vitour = registeredToolNames;
    } catch (error) {
        config.tools.vitour.enabled = false;
        config.tools.vitour.runtimeError = error instanceof Error ? error.message : String(error);
        console.warn(`Vitour tools failed to register: ${config.tools.vitour.runtimeError}`);
    }
} else {
    toolsByGroup.vitour = [];
    console.warn(
        `Vitour tools disabled. reason=${config.tools.vitour.disabledReason || "unknown"} missing=${config.tools.vitour.missingEnvVars.join(", ")}`
    );
}

if (!config.tools.browser.enabled) {
    toolsByGroup.browser = [];
}

if (config.tools.qa.enabled) {
    try {
        const {registeredToolNames = []} = registerQaTools(server, {
            dbClient,
            browserConfig: config.browser
        });
        toolsByGroup.qa = registeredToolNames;
        if (!dbClient) {
            config.tools.qa.partial = true;
            config.tools.qa.note = "SQL-backed QA tools are disabled until PostgreSQL is available.";
        }
    } catch (error) {
        config.tools.qa.enabled = false;
        config.tools.qa.runtimeError = error instanceof Error ? error.message : String(error);
        toolsByGroup.qa = [];
        console.warn(`QA tools failed to register: ${config.tools.qa.runtimeError}`);
    }
} else {
    toolsByGroup.qa = [];
}

const latencyReportService = createLatencyReportService({
    monitoringConfig: {
        enabled: config.tools.monitoring.enabled,
        outventoRoot: config.monitoring.outventoRoot,
        sshHost: config.monitoring.sshHost,
        sshUser: config.monitoring.sshUser,
        sshKeyPath: config.monitoring.sshKeyPath
    }
});

if (config.tools.monitoring.enabled) {
    const {registeredToolNames = []} = registerMonitoringTools(server, {latencyReportService});
    toolsByGroup.monitoring = registeredToolNames;
} else {
    toolsByGroup.monitoring = [];
    console.warn(
        `Monitoring tools disabled. reason=${config.tools.monitoring.disabledReason || "unknown"} missing=${config.tools.monitoring.missingEnvVars.join(", ")}`
    );
}

registerHealthTool(server, {
    dbClient,
    swaggerService,
    swaggerAvailability: config.tools.swagger,
    swaggerUrl: config.swaggerUrl,
    browserAvailability: config.tools.browser,
    browserConfig: config.browser,
    vitourAvailability: config.tools.vitour,
    vitourConfig: config.vitour
});
registerStatusTool(server, {
    toolAvailability: config.tools,
    registeredToolNamesByGroup: toolsByGroup,
    alwaysRegisteredToolNames: ["health"]
});

const transport = new StdioServerTransport();
await server.connect(transport);
