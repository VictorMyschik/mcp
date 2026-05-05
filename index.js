import "dotenv/config";
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js";

import {config} from "./src/config/env.js";
import {createDbClient} from "./src/infrastructure/db/client.js";
import {createSwaggerService} from "./src/services/swagger/swagger-cache.js";
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
    swagger: ["list_api_endpoints", "get_endpoint", "get_schema", "find_endpoint_by_keyword", "call_api_by_swagger", "auth_login", "auth_logout", "auth_status", "get_profile_page", "get_translations", "update_profile"]
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
if (config.tools.swagger.enabled) {
    try {
        swaggerService = createSwaggerService({swaggerUrl: config.swaggerUrl});
        const {registeredToolNames = []} = await registerSwaggerTools(server, {
            swaggerService,
            authConfig: config.auth,
            apiConfig: config.api
        });
        toolsByGroup.swagger = registeredToolNames;
    } catch (error) {
        swaggerService = null;
        config.tools.swagger.enabled = false;
        config.tools.swagger.runtimeError = error instanceof Error ? error.message : String(error);
        console.warn(`Swagger tools failed to register: ${config.tools.swagger.runtimeError}`);
    }
} else {
    console.warn(`Swagger tools disabled. Missing env vars: ${config.tools.swagger.missingEnvVars.join(", ")}`);
}

registerHealthTool(server, {dbClient, swaggerService});
registerStatusTool(server, {
    toolAvailability: config.tools,
    registeredToolNamesByGroup: toolsByGroup,
    alwaysRegisteredToolNames: ["health"]
});

const transport = new StdioServerTransport();
await server.connect(transport);
