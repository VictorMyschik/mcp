import * as z from "zod/v4";
import fetch from "node-fetch";

import {normalizeEndpoint} from "../services/swagger/normalize-endpoint.js";
import {getErrorMessage} from "../utils/errors.js";
import {asToolResult} from "./tool-result.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

function resolveBaseUrl({baseUrl, swagger, swaggerUrl}) {
    const preferred = String(baseUrl ?? "").trim();
    if (preferred) {
        return preferred;
    }

    const serverUrl = String(swagger?.servers?.[0]?.url ?? "").trim();
    if (serverUrl) {
        return serverUrl;
    }

    try {
        return new URL(swaggerUrl).origin;
    } catch {
        return null;
    }
}

function resolvePathTemplate(pathTemplate, pathParams) {
    const missingPathParams = [];

    // Replace {param} placeholders from OpenAPI path templates.
    const resolvedPath = String(pathTemplate ?? "").replace(/\{([^}]+)\}/g, (_, key) => {
        const value = pathParams?.[key];
        if (value === undefined || value === null || value === "") {
            missingPathParams.push(key);
            return `{${key}}`;
        }

        return encodeURIComponent(String(value));
    });

    if (missingPathParams.length > 0) {
        throw new Error(`Missing required path params: ${missingPathParams.join(", ")}`);
    }

    return resolvedPath;
}

function appendQueryParams(url, query) {
    if (!query || typeof query !== "object") {
        return;
    }

    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) {
            continue;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                if (item !== undefined && item !== null) {
                    url.searchParams.append(key, String(item));
                }
            }
            continue;
        }

        url.searchParams.append(key, String(value));
    }
}

function collectRequiredParams(pathItem, operation) {
    const combined = [
        ...(Array.isArray(pathItem?.parameters) ? pathItem.parameters : []),
        ...(Array.isArray(operation?.parameters) ? operation.parameters : [])
    ];

    return combined.filter((parameter) => parameter?.required === true);
}

async function parseResponseBody(response) {
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const text = await response.text();
    if (!text) {
        return null;
    }

    if (contentType.includes("application/json")) {
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }

    return text;
}

export function registerSwaggerTools(server, {swaggerService, fetchImpl = fetch}) {
    server.registerTool(
        "list_api_endpoints",
        {
            description: "List all Swagger path entries.",
            inputSchema: {}
        },
        async () => {
            try {
                const swagger = await swaggerService.loadSwagger();
                return asToolResult({paths: Object.keys(swagger.paths || {})});
            } catch (error) {
                throw new Error(`Failed to list API endpoints: ${getErrorMessage(error)}`);
            }
        }
    );

    server.registerTool(
        "get_endpoint",
        {
            description: "Get operation details by path and HTTP method.",
            inputSchema: {
                path: z.string().min(1),
                method: z.string().min(1)
            }
        },
        async ({path, method}) => {
            try {
                const swagger = await swaggerService.loadSwagger();
                const normalizedMethod = String(method ?? "").toLowerCase();
                const endpoint = swagger.paths?.[path]?.[normalizedMethod] || null;

                return asToolResult({endpoint: normalizeEndpoint(endpoint, path, normalizedMethod)});
            } catch (error) {
                throw new Error(`Failed to get endpoint details: ${getErrorMessage(error)}`);
            }
        }
    );

    server.registerTool(
        "get_schema",
        {
            description: "Get schema definition by name from Swagger components.",
            inputSchema: {
                name: z.string().min(1)
            }
        },
        async ({name}) => {
            try {
                const swagger = await swaggerService.loadSwagger();
                return asToolResult({schema: swagger.components?.schemas?.[name] || null});
            } catch (error) {
                throw new Error(`Failed to get schema: ${getErrorMessage(error)}`);
            }
        }
    );

    server.registerTool(
        "find_endpoint_by_keyword",
        {
            description: "Find Swagger paths containing a keyword.",
            inputSchema: {
                keyword: z.string()
            }
        },
        async ({keyword}) => {
            const normalizedKeyword = String(keyword ?? "").trim();
            if (!normalizedKeyword) {
                return asToolResult({paths: []});
            }

            const swagger = await swaggerService.loadSwagger();
            const searchKeyword = normalizedKeyword.toLowerCase();

            const paths = Object.keys(swagger.paths || {}).filter((path) =>
                path.toLowerCase().includes(searchKeyword)
            );

            return asToolResult({paths});
        }
    );

    server.registerTool(
        "call_api_by_swagger",
        {
            description: "Call an API operation by Swagger path/method with optional path, query, headers and JSON body.",
            inputSchema: {
                path: z.string().min(1),
                method: z.string().min(1),
                baseUrl: z.string().url().optional(),
                pathParams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
                query: z.record(z.string(), z.unknown()).optional(),
                body: z.unknown().optional(),
                headers: z.record(z.string(), z.string()).optional()
            }
        },
        async ({path, method, baseUrl, pathParams = {}, query = {}, body, headers = {}}) => {
            try {
                const swagger = await swaggerService.loadSwagger();
                const normalizedMethod = String(method ?? "").toLowerCase();
                if (!HTTP_METHODS.has(normalizedMethod)) {
                    throw new Error(`Unsupported HTTP method: ${method}`);
                }

                const pathItem = swagger.paths?.[path];
                if (!pathItem || typeof pathItem !== "object") {
                    throw new Error(`Path not found in Swagger: ${path}`);
                }

                const operation = pathItem[normalizedMethod];
                if (!operation || typeof operation !== "object") {
                    const availableMethods = Object.keys(pathItem)
                        .filter((key) => HTTP_METHODS.has(key))
                        .sort();
                    throw new Error(
                        `Method '${normalizedMethod}' is not defined for path '${path}'. Available: ${availableMethods.join(", ") || "none"}`
                    );
                }

                const requiredParams = collectRequiredParams(pathItem, operation);
                for (const parameter of requiredParams) {
                    if (parameter.in === "query" && query?.[parameter.name] === undefined) {
                        throw new Error(`Missing required query param: ${parameter.name}`);
                    }
                    if (parameter.in === "path" && pathParams?.[parameter.name] === undefined) {
                        throw new Error(`Missing required path param: ${parameter.name}`);
                    }
                }

                if (operation.requestBody?.required === true && body === undefined) {
                    throw new Error("Request body is required by Swagger but was not provided.");
                }

                const resolvedBaseUrl = resolveBaseUrl({baseUrl, swagger, swaggerUrl: swaggerService.url});
                if (!resolvedBaseUrl) {
                    throw new Error("Unable to resolve API base URL from input, Swagger servers or SWAGGER_URL.");
                }

                const resolvedPath = resolvePathTemplate(path, pathParams);
                const requestUrl = new URL(resolvedPath, resolvedBaseUrl);
                appendQueryParams(requestUrl, query);

                const requestHeaders = {
                    accept: "application/json",
                    ...headers
                };

                let serializedBody;
                if (body !== undefined) {
                    serializedBody = JSON.stringify(body);
                    if (!Object.keys(requestHeaders).some((key) => key.toLowerCase() === "content-type")) {
                        requestHeaders["content-type"] = "application/json";
                    }
                }

                const response = await fetchImpl(requestUrl.toString(), {
                    method: normalizedMethod.toUpperCase(),
                    headers: requestHeaders,
                    body: serializedBody
                });

                const parsedBody = await parseResponseBody(response);

                return asToolResult({
                    request: {
                        method: normalizedMethod.toUpperCase(),
                        url: requestUrl.toString()
                    },
                    response: {
                        ok: response.ok,
                        status: response.status,
                        statusText: response.statusText,
                        headers: Object.fromEntries(response.headers.entries()),
                        body: parsedBody
                    }
                });
            } catch (error) {
                throw new Error(`Failed to call Swagger API: ${getErrorMessage(error)}`);
            }
        }
    );
}
