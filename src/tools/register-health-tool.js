import {getErrorMessage} from "../utils/errors.js";
import {asToolResult} from "./tool-result.js";

export function registerHealthTool(server, {dbClient, swaggerService, browserAvailability, browserConfig}) {
    server.registerTool(
        "health",
        {
            description: "Check DB, Swagger, and browser automation availability and return service health.",
            inputSchema: {}
        },
        async () => {
            const health = {
                status: "ok",
                timestamp: new Date().toISOString(),
                db: {ok: false, enabled: Boolean(dbClient)},
                swagger: {ok: false, enabled: Boolean(swaggerService), url: swaggerService?.url || null},
                browser: {
                    ok: browserAvailability?.enabled === true,
                    enabled: browserAvailability?.enabled === true,
                    artifactsDir: browserConfig?.artifactsDir || null,
                    sessionTtlMs: browserConfig?.sessionTtlMs || null,
                    runtimeError: browserAvailability?.runtimeError || null
                }
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

            if (browserAvailability?.enabled !== true) {
                health.browser.reason = browserAvailability?.runtimeError ? "registration_failed" : "disabled_by_config";
                if (browserAvailability?.runtimeError) {
                    health.status = "degraded";
                }
            }

            return asToolResult(health);
        }
    );
}
