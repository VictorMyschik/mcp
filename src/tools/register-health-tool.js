import {getErrorMessage} from "../utils/errors.js";
import {asToolResult} from "./tool-result.js";

export function registerHealthTool(server, {dbClient, swaggerService}) {
    server.registerTool(
        "health",
        {
            description: "Check DB and Swagger availability and return service health.",
            inputSchema: {}
        },
        async () => {
            const health = {
                status: "ok",
                timestamp: new Date().toISOString(),
                db: {ok: false, enabled: Boolean(dbClient)},
                swagger: {ok: false, enabled: Boolean(swaggerService), url: swaggerService?.url || null}
            };

            if (dbClient) {
                try {
                    await dbClient.query("SELECT 1");
                    health.db.ok = true;
                } catch (error) {
                    health.status = "degraded";
                    health.db.error = getErrorMessage(error);
                }
            } else {
                health.db.reason = "disabled_missing_env";
            }

            if (swaggerService) {
                try {
                    const swagger = await swaggerService.loadSwagger({forceRefresh: true});
                    health.swagger.ok = true;
                    health.swagger.endpoints = Object.keys(swagger.paths || {}).length;
                } catch (error) {
                    health.status = "degraded";
                    health.swagger.error = getErrorMessage(error);
                }
            } else {
                health.swagger.reason = "disabled_missing_env";
            }

            return asToolResult(health);
        }
    );
}
