import {getErrorMessage} from "../utils/errors.js";
import {normalizeEndpoint} from "../services/swagger/normalize-endpoint.js";

export function registerSwaggerTools(server, {swaggerService}) {
    server.tool(
        "list_api_endpoints",
        {},
        async () => {
            try {
                const swagger = await swaggerService.loadSwagger();
                return Object.keys(swagger.paths || {});
            } catch (error) {
                throw new Error(`Failed to list API endpoints: ${getErrorMessage(error)}`);
            }
        }
    );

    server.tool(
        "get_endpoint",
        {
            path: "string",
            method: "string"
        },
        async ({path, method}) => {
            try {
                const swagger = await swaggerService.loadSwagger();
                const normalizedMethod = String(method ?? "").toLowerCase();
                const endpoint = swagger.paths?.[path]?.[normalizedMethod] || null;

                return normalizeEndpoint(endpoint, path, normalizedMethod);
            } catch (error) {
                throw new Error(`Failed to get endpoint details: ${getErrorMessage(error)}`);
            }
        }
    );

    server.tool(
        "get_schema",
        {
            name: "string"
        },
        async ({name}) => {
            try {
                const swagger = await swaggerService.loadSwagger();
                return swagger.components?.schemas?.[name] || null;
            } catch (error) {
                throw new Error(`Failed to get schema: ${getErrorMessage(error)}`);
            }
        }
    );

    server.tool(
        "find_endpoint_by_keyword",
        {
            keyword: "string"
        },
        async ({keyword}) => {
            const normalizedKeyword = String(keyword ?? "").trim();
            if (!normalizedKeyword) {
                return [];
            }

            const swagger = await swaggerService.loadSwagger();
            const searchKeyword = normalizedKeyword.toLowerCase();

            return Object.keys(swagger.paths || {}).filter((path) =>
                path.toLowerCase().includes(searchKeyword)
            );
        }
    );
}

