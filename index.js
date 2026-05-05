import "dotenv/config";
import {Server} from "@modelcontextprotocol/sdk/server/index.js";

import {config} from "./src/config/env.js";
import {createDbClient} from "./src/infrastructure/db/client.js";
import {createSwaggerService} from "./src/services/swagger/swagger-cache.js";
import {registerHealthTool} from "./src/tools/register-health-tool.js";
import {registerStatusTool} from "./src/tools/register-status-tool.js";
import {registerSqlTools} from "./src/tools/register-sql-tools.js";
import {registerSwaggerTools} from "./src/tools/register-swagger-tools.js";

const server = new Server({
    name: "unified-mcp",
    version: "1.0.0"
});

const toolsByGroup = {
    sql: ["run_sql", "list_tables"],
    swagger: ["list_api_endpoints", "get_endpoint", "get_schema", "find_endpoint_by_keyword"]
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
    swaggerService = createSwaggerService({swaggerUrl: config.swaggerUrl});
    registerSwaggerTools(server, {swaggerService});
} else {
    console.warn(`Swagger tools disabled. Missing env vars: ${config.tools.swagger.missingEnvVars.join(", ")}`);
}

registerHealthTool(server, {dbClient, swaggerService});
registerStatusTool(server, {
    toolAvailability: config.tools,
    registeredToolNamesByGroup: toolsByGroup,
    alwaysRegisteredToolNames: ["health"]
});

server.start();
