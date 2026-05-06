import "dotenv/config";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";

import {config} from "./src/config/env.js";
import {createDbClient} from "./src/infrastructure/db/client.js";
import {createSwaggerService} from "./src/services/swagger/swagger-cache.js";
import {registerBrowserTools} from "./src/tools/register-browser-tools.js";
import {registerHealthTool} from "./src/tools/register-health-tool.js";
import {registerStatusTool} from "./src/tools/register-status-tool.js";
import {registerSqlTools} from "./src/tools/register-sql-tools.js";
import {registerSwaggerTools} from "./src/tools/register-swagger-tools.js";

const server = new McpServer({
    name: "unified-mcp",
    version: "1.0.0"
});

const toolsByGroup = {
    sql: ["run_sql", "list_tables"],
    swagger: ["list_api_endpoints", "get_endpoint", "get_schema", "find_endpoint_by_keyword", "call_api_by_swagger", "auth_login", "auth_logout", "auth_status", "get_profile_page", "get_translations", "update_profile"],
    browser: ["browser_open_session", "browser_close_session", "browser_navigate", "browser_auth_from_api_login", "browser_open_profile_page", "browser_open_account_home", "browser_open_security_page", "browser_capture_profile_mobile", "browser_wait_for", "browser_click", "browser_fill", "browser_press", "browser_evaluate", "browser_get_text", "browser_get_attribute", "browser_screenshot", "browser_get_bounding_rect", "browser_get_computed_styles", "browser_assert_layout", "browser_save_storage_state", "browser_load_storage_state", "browser_get_console_logs", "browser_get_network_errors", "browser_inspect_page"]
};

let dbClient = null;
if (config.tools.sql.enabled) {
    dbClient = createDbClient(config.db);
    await dbClient.connect();
    registerSqlTools(server, {dbClient});
} else {
    console.warn(`SQL tools disabled. Missing env vars: ${config.tools.sql.missingEnvVars.join(", ")}`);
}

let swaggerService = null;
let sharedAuthSession = null;
if (config.tools.swagger.enabled) {
    try {
        swaggerService = createSwaggerService({swaggerUrl: config.swaggerUrl});
        const {registeredToolNames = [], authSession} = await registerSwaggerTools(server, {
            swaggerService,
            authConfig: config.auth,
            apiConfig: config.api
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
        const {registeredToolNames = []} = await registerBrowserTools(server, {
            browserConfig: config.browser,
            authConfig: config.auth,
            apiConfig: config.api,
            sharedAuthSession
        });
        toolsByGroup.browser = registeredToolNames;
    } catch (error) {
        config.tools.browser.enabled = false;
        config.tools.browser.runtimeError = error instanceof Error ? error.message : String(error);
        console.warn(`Browser tools failed to register: ${config.tools.browser.runtimeError}`);
    }
}

registerHealthTool(server, {
    dbClient,
    swaggerService,
    browserAvailability: config.tools.browser,
    browserConfig: config.browser
});
registerStatusTool(server, {
    toolAvailability: config.tools,
    registeredToolNamesByGroup: toolsByGroup,
    alwaysRegisteredToolNames: ["health"]
});

const transport = new StdioServerTransport();
await server.connect(transport);
