import * as z from "zod/v4";
import fetch from "node-fetch";

import {createAuthSession} from "../services/auth/auth-session.js";
import {buildRequestUrl, executeHttpRequest} from "../services/swagger/http-executor.js";
import {collectEndpointSchemaNames, normalizeEndpoint} from "../services/swagger/normalize-endpoint.js";
import {getErrorMessage} from "../utils/errors.js";
import {asToolResult} from "./tool-result.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const scalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const headerValueSchema = z.union([scalarSchema, z.array(scalarSchema)]);
const multipartFieldSchema = z.object({
    name: z.string().min(1),
    value: scalarSchema.optional(),
    filePath: z.string().min(1).optional(),
    fileName: z.string().min(1).optional(),
    contentType: z.string().min(1).optional(),
    text: z.string().optional(),
    base64: z.string().min(1).optional()
});
const rawApiInputSchema = {
    method: z.string().min(1),
    baseUrl: z.string().url().optional(),
    url: z.string().url().optional(),
    path: z.string().min(1).optional(),
    pathParams: z.record(z.string(), scalarSchema).optional(),
    query: z.record(z.string(), z.unknown()).optional(),
    headers: z.record(z.string(), headerValueSchema).optional(),
    jsonBody: z.unknown().optional(),
    textBody: z.string().optional(),
    multipart: z.object({
        fields: z.array(multipartFieldSchema).min(1)
    }).optional(),
    timeoutMs: z.number().int().positive().optional(),
    expectedResponseType: z.enum(["auto", "json", "text", "base64"]).optional(),
    includeRawBody: z.boolean().optional(),
    useExistingMcpAuth: z.boolean().optional()
};

const DETERMINISTIC_TOOL_SPECS = {
    get_profile_page: {
        preferredOperationId: "getProfilePage",
        aliases: ["profilePage"],
        hint: {
            path: "/api/v1/user/profile/page",
            method: "get"
        }
    },
    get_translations: {
        preferredOperationId: "getTranslations"
    },
    update_profile: {
        preferredOperationId: "updateProfile"
    }
};

function resolveBaseUrl({swagger, swaggerUrl}) {
    const serverUrl = String(swagger?.servers?.[0]?.url ?? "").trim();
    if (serverUrl) {
        return serverUrl;
    }

    try {
        return new URL(swaggerUrl).origin;
    } catch {
        throw new Error("Unable to resolve API base URL from Swagger servers or SWAGGER_URL.");
    }
}

function collectRequiredParams(pathItem, operation) {
    const combined = [
        ...(Array.isArray(pathItem?.parameters) ? pathItem.parameters : []),
        ...(Array.isArray(operation?.parameters) ? operation.parameters : [])
    ];

    return combined.filter((parameter) => parameter?.required === true);
}

function normalizeOperationId(operationId) {
    const normalized = String(operationId || "")
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/[^a-zA-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase();

    if (!normalized) {
        throw new Error("Swagger operationId cannot be empty.");
    }

    return normalized;
}

function extractOperations(swagger) {
    const operations = [];

    for (const [path, pathItem] of Object.entries(swagger.paths || {})) {
        if (!pathItem || typeof pathItem !== "object") {
            continue;
        }

        for (const [method, operation] of Object.entries(pathItem)) {
            const normalizedMethod = String(method || "").toLowerCase();
            if (!HTTP_METHODS.has(normalizedMethod)) {
                continue;
            }

            operations.push({
                path,
                method: normalizedMethod,
                operation,
                pathItem
            });
        }
    }

    return operations;
}

function buildOperationIndex(operations) {
    const operationIndex = new Map();

    for (const entry of operations) {
        const operationId = String(entry.operation?.operationId || "").trim();
        if (!operationId) {
            continue;
        }

        if (operationIndex.has(operationId)) {
            const previous = operationIndex.get(operationId);
            throw new Error(
                `Duplicate Swagger operationId '${operationId}' found at ${previous.method.toUpperCase()} ${previous.path} and ${entry.method.toUpperCase()} ${entry.path}.`
            );
        }

        operationIndex.set(operationId, {
            ...entry,
            operationId
        });
    }

    return operationIndex;
}

function toCoreOperationId(operationId) {
    const normalized = normalizeOperationId(operationId);
    return normalized.replace(/^(get|list|create|update|delete|set|fetch)_+/, "");
}

function resolveDeterministicToolMappings({operationIndex, discoveredOperations, toolSpecs}) {
    const resolved = new Map();
    const warnings = [];

    for (const [toolName, toolSpec] of Object.entries(toolSpecs)) {
        const preferredOperationId = String(toolSpec?.preferredOperationId || "").trim();
        const aliases = Array.isArray(toolSpec?.aliases)
            ? toolSpec.aliases.map((value) => String(value || "").trim()).filter(Boolean)
            : [];
        const hintPath = String(toolSpec?.hint?.path || "").trim();
        const hintMethod = String(toolSpec?.hint?.method || "").trim().toLowerCase();

        if (preferredOperationId && operationIndex.has(preferredOperationId)) {
            resolved.set(toolName, preferredOperationId);
            continue;
        }

        const aliasMatch = aliases.find((alias) => operationIndex.has(alias));
        if (aliasMatch) {
            resolved.set(toolName, aliasMatch);
            warnings.push(`Adaptive mapping: '${toolName}' switched to alias operationId '${aliasMatch}' (preferred '${preferredOperationId}' not found).`);
            continue;
        }

        if (hintPath && hintMethod) {
            const hintedMatches = discoveredOperations
                .filter((entry) => entry.path === hintPath && entry.method === hintMethod)
                .map((entry) => String(entry.operation?.operationId || "").trim())
                .filter(Boolean);

            if (hintedMatches.length === 1) {
                resolved.set(toolName, hintedMatches[0]);
                warnings.push(`Adaptive mapping: '${toolName}' resolved by hint ${hintMethod.toUpperCase()} ${hintPath} -> '${hintedMatches[0]}'.`);
                continue;
            }

            if (hintedMatches.length > 1) {
                warnings.push(`Skipped deterministic wrapper '${toolName}': hint ${hintMethod.toUpperCase()} ${hintPath} is ambiguous (${hintedMatches.join(", ")}).`);
                continue;
            }
        }

        const targetCoreIds = [preferredOperationId, ...aliases]
            .filter(Boolean)
            .map((value) => toCoreOperationId(value));
        const coreMatches = [...operationIndex.keys()].filter((operationId) =>
            targetCoreIds.includes(toCoreOperationId(operationId))
        );

        if (coreMatches.length === 1) {
            resolved.set(toolName, coreMatches[0]);
            warnings.push(`Adaptive mapping: '${toolName}' resolved by normalized core match -> '${coreMatches[0]}'.`);
            continue;
        }

        if (coreMatches.length > 1) {
            warnings.push(`Skipped deterministic wrapper '${toolName}': normalized match is ambiguous (${coreMatches.join(", ")}).`);
            continue;
        }

        warnings.push(`Skipped deterministic wrapper '${toolName}': operationId '${preferredOperationId}' not found in Swagger and no safe adaptive match.`);
    }

    return {resolved, warnings};
}

function buildUnauthorizedResult() {
    return {
        ok: false,
        error: {
            kind: "unauthorized",
            status: 401,
            message: "Unauthorized: call auth_login first"
        }
    };
}

function buildStructuredExecutionError(error, fallbackKind = "mcp_execution_error") {
    return {
        ok: false,
        error: {
            kind: fallbackKind,
            message: getErrorMessage(error)
        }
    };
}

function buildOperationPayload(entry) {
    return {
        path: entry.path,
        method: entry.method.toUpperCase(),
        operationId: entry.operation?.operationId || entry.operationId || null
    };
}

function resolveEndpointByInput({operationIndex, swagger, operationId, path, method}) {
    if (operationId) {
        return getOperationById(operationIndex, operationId);
    }

    const normalizedPath = String(path || "").trim();
    const normalizedMethod = String(method || "").trim().toLowerCase();
    if (!normalizedPath || !normalizedMethod) {
        throw new Error("Provide either operationId or both path and method.");
    }

    const operation = swagger.paths?.[normalizedPath]?.[normalizedMethod];
    if (!operation) {
        throw new Error(`Swagger endpoint not found: ${normalizedMethod.toUpperCase()} ${normalizedPath}`);
    }

    return {
        path: normalizedPath,
        method: normalizedMethod,
        pathItem: swagger.paths?.[normalizedPath] || null,
        operation,
        operationId: operation.operationId || null
    };
}

function buildEndpointInspectionPayload({swagger, entry, includeSchemaDefinitions = false}) {
    const endpoint = normalizeEndpoint(entry.operation, entry.path, entry.method, entry.pathItem);
    const schemaNames = collectEndpointSchemaNames(endpoint);
    return {
        endpoint,
        ...(includeSchemaDefinitions
            ? {
                schemaDefinitions: Object.fromEntries(
                    schemaNames.map((schemaName) => [schemaName, swagger.components?.schemas?.[schemaName] || null])
                )
            }
            : {}),
        schemaNames
    };
}

async function executeOperation({
    swaggerService,
    authSession,
    apiConfig,
    fetchImpl,
    path,
    method,
    pathItem,
    operation,
    pathParams = {},
    query = {},
    body,
    authMode = "auto",
    baseUrlOverride
}) {
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

    const swagger = await swaggerService.loadSwagger();
    const baseUrl = baseUrlOverride || resolveBaseUrl({swagger, swaggerUrl: swaggerService.url});
    const requestUrl = buildRequestUrl({baseUrl, path, pathParams, query});

    const swaggerRequiresAuth = Array.isArray(operation.security)
        ? operation.security.length > 0
        : Array.isArray(swagger.security) && swagger.security.length > 0;
    const requiresAuth = authMode === "required" ? true : swaggerRequiresAuth;

    async function sendRequest() {
        const requestHeaders = {
            accept: "application/json"
        };

        if (requiresAuth) {
            if (authMode !== "required") {
                await authSession.ensureAuthenticated();
            }
            const authorization = authSession.getAuthorizationHeader();
            if (!authorization) {
                throw new Error("Unauthorized: call auth_login first");
            }
            requestHeaders.authorization = authorization;
        }

        return executeHttpRequest({
            fetchImpl,
            method,
            requestUrl,
            headers: requestHeaders,
            jsonBody: body,
            timeoutMs: apiConfig.requestTimeoutMs,
            expectedResponseType: "auto",
            includeRawBody: false
        });
    }

    let response = await sendRequest();
    if (response.error?.status === 401 && requiresAuth && apiConfig.retryOnUnauthorized && authMode !== "required") {
        await authSession.login();
        response = await sendRequest();
    }

    if (!response.ok) {
        if (response.error?.status === 401) {
            return {
                ...buildUnauthorizedResult(),
                operation: buildOperationPayload({path, method, operation})
            };
        }

        return {
            ok: false,
            error: {
                kind: response.error?.kind || "api_error",
                status: response.error?.status || null,
                message: response.error?.message || "Unknown error",
                contentType: response.response?.contentType || null,
                headers: response.response?.headers || null,
                body: response.response?.body ?? null,
                rawBody: response.response?.rawBody ?? null,
                parseError: response.response?.parseError || null
            },
            operation: buildOperationPayload({path, method, operation})
        };
    }

    return {
        ok: true,
        operation: buildOperationPayload({path, method, operation}),
        data: response.response?.body ?? null
    };
}

function getOperationById(operationIndex, operationId) {
    const normalizedOperationId = String(operationId || "").trim();
    if (!normalizedOperationId) {
        throw new Error("operationId is required.");
    }

    const operationEntry = operationIndex.get(normalizedOperationId);
    if (!operationEntry) {
        throw new Error(`Swagger operationId not found: ${normalizedOperationId}`);
    }

    return operationEntry;
}

async function callApiBySwagger({
    swaggerService,
    authSession,
    apiConfig,
    fetchImpl,
    operationIndex,
    operationId,
    pathParams = {},
    query = {},
    body,
    baseUrl
}) {
    const entry = getOperationById(operationIndex, operationId);

    return executeOperation({
        swaggerService,
        authSession,
        apiConfig,
        fetchImpl,
        path: entry.path,
        method: entry.method,
        pathItem: entry.pathItem,
        operation: entry.operation,
        pathParams,
        query,
        body,
        authMode: "required",
        baseUrlOverride: baseUrl
    });
}

async function callApiRaw({
    swaggerService,
    authSession,
    apiConfig,
    fetchImpl,
    method,
    baseUrl,
    url,
    path,
    pathParams = {},
    query = {},
    headers = {},
    jsonBody,
    textBody,
    multipart,
    timeoutMs,
    expectedResponseType = "auto",
    includeRawBody = false,
    useExistingMcpAuth = false
}) {
    const requestHeaders = {...(headers || {})};

    if (useExistingMcpAuth) {
        const authorizationHeaderName = Object.keys(requestHeaders).find((headerName) => headerName.toLowerCase() === "authorization");
        if (!authorizationHeaderName) {
            await authSession.ensureAuthenticated();
            const authorization = authSession.getAuthorizationHeader();
            if (!authorization) {
                return buildUnauthorizedResult();
            }
            requestHeaders.authorization = authorization;
        }
    }

    const swagger = swaggerService ? await swaggerService.loadSwagger() : null;
    const requestUrl = buildRequestUrl({
        url,
        baseUrl: baseUrl || (swagger ? resolveBaseUrl({swagger, swaggerUrl: swaggerService.url}) : undefined),
        path,
        pathParams,
        query
    });

    return executeHttpRequest({
        fetchImpl,
        method,
        requestUrl,
        headers: requestHeaders,
        jsonBody,
        textBody,
        multipart,
        timeoutMs: timeoutMs || apiConfig.requestTimeoutMs,
        expectedResponseType,
        includeRawBody
    });
}

export async function registerSwaggerTools(server, {
    swaggerService,
    authConfig,
    apiConfig,
    authSession: providedAuthSession,
    fetchImpl = fetch
}) {
    const swagger = await swaggerService.loadSwagger();
    const discoveredOperations = extractOperations(swagger);
    const operationIndex = buildOperationIndex(discoveredOperations);
    const {resolved: resolvedDeterministicToolMappings, warnings: adaptiveMappingWarnings} = resolveDeterministicToolMappings({
        operationIndex,
        discoveredOperations,
        toolSpecs: DETERMINISTIC_TOOL_SPECS
    });

    for (const warning of adaptiveMappingWarnings) {
        console.warn(warning);
    }

    const authSession = providedAuthSession || createAuthSession({
        authConfig,
        fetchImpl,
        timeoutMs: apiConfig.requestTimeoutMs,
        buildBaseUrl: () => resolveBaseUrl({swagger, swaggerUrl: swaggerService.url})
    });

    async function loadLatestSwagger(forceRefresh = false) {
        return swaggerService.loadSwagger({forceRefresh});
    }

    const registeredTools = [
        "list_api_endpoints",
        "get_endpoint",
        "inspect_swagger_endpoint",
        "get_schema",
        "find_endpoint_by_keyword",
        "call_api_raw",
        "call_api_by_swagger",
        "auth_login",
        "auth_logout",
        "auth_status",
        ...resolvedDeterministicToolMappings.keys()
    ];

    server.registerTool(
        "auth_login",
        {
            description: "Authenticate once and store token in MCP session for future API tools.",
            inputSchema: {
                login: z.string().min(1).optional(),
                username: z.string().min(1).optional(),
                password: z.string().min(1).optional()
            }
        },
        async ({login, username, password}) => {
            try {
                const result = await authSession.login({login, username, password});
                return asToolResult({ok: true, auth: result});
            } catch (error) {
                return asToolResult({
                    ok: false,
                    error: {
                        kind: "auth_error",
                        message: getErrorMessage(error)
                    }
                });
            }
        }
    );

    server.registerTool(
        "call_api_raw",
        {
            description: "Make a raw HTTP request with full control over method, URL construction, headers, query params, body mode, and response parsing.",
            inputSchema: rawApiInputSchema
        },
        async ({
            method,
            baseUrl,
            url,
            path,
            pathParams = {},
            query = {},
            headers = {},
            jsonBody,
            textBody,
            multipart,
            timeoutMs,
            expectedResponseType,
            includeRawBody,
            useExistingMcpAuth
        }) => {
            try {
                const result = await callApiRaw({
                    swaggerService,
                    authSession,
                    apiConfig,
                    fetchImpl,
                    method,
                    baseUrl,
                    url,
                    path,
                    pathParams,
                    query,
                    headers,
                    jsonBody,
                    textBody,
                    multipart,
                    timeoutMs,
                    expectedResponseType,
                    includeRawBody,
                    useExistingMcpAuth
                });

                return asToolResult(result);
            } catch (error) {
                if (getErrorMessage(error).includes("Unauthorized: call auth_login first")) {
                    return asToolResult(buildUnauthorizedResult());
                }

                return asToolResult(buildStructuredExecutionError(error, "request_validation_error"));
            }
        }
    );

    server.registerTool(
        "call_api_by_swagger",
        {
            description: "Call a Swagger operation by operationId. Auth header is injected automatically from MCP session.",
            inputSchema: {
                operationId: z.string().min(1),
                pathParams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
                query: z.record(z.string(), z.unknown()).optional(),
                body: z.unknown().optional(),
                baseUrl: z.string().url().optional()
            }
        },
        async ({operationId, pathParams = {}, query = {}, body, baseUrl}) => {
            try {
                const result = await callApiBySwagger({
                    swaggerService,
                    authSession,
                    apiConfig,
                    fetchImpl,
                    operationIndex,
                    operationId,
                    pathParams,
                    query,
                    body,
                    baseUrl
                });

                return asToolResult(result);
            } catch (error) {
                if (getErrorMessage(error).includes("Unauthorized: call auth_login first")) {
                    return asToolResult(buildUnauthorizedResult());
                }

                return asToolResult(buildStructuredExecutionError(error));
            }
        }
    );

    server.registerTool(
        "auth_logout",
        {
            description: "Clear the stored auth token from MCP session memory.",
            inputSchema: {}
        },
        async () => {
            authSession.clearAuth();
            return asToolResult({ok: true, message: "Auth session cleared."});
        }
    );

    server.registerTool(
        "auth_status",
        {
            description: "Return whether MCP currently has a stored token and fallback credentials.",
            inputSchema: {}
        },
        async () => asToolResult({ok: true, auth: authSession.getState()})
    );

    server.registerTool(
        "list_api_endpoints",
        {
            description: "List all Swagger path entries.",
            inputSchema: {
                forceRefresh: z.boolean().optional()
            }
        },
        async ({forceRefresh} = {}) => {
            try {
                const latestSwagger = await loadLatestSwagger(forceRefresh);
                return asToolResult({paths: Object.keys(latestSwagger.paths || {})});
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
                method: z.string().min(1),
                forceRefresh: z.boolean().optional()
            }
        },
        async ({path, method, forceRefresh}) => {
            try {
                const latestSwagger = await loadLatestSwagger(forceRefresh);
                const normalizedMethod = String(method ?? "").toLowerCase();
                const endpoint = latestSwagger.paths?.[path]?.[normalizedMethod] || null;
                return asToolResult({
                    endpoint: normalizeEndpoint(endpoint, path, normalizedMethod, latestSwagger.paths?.[path] || null)
                });
            } catch (error) {
                throw new Error(`Failed to get endpoint details: ${getErrorMessage(error)}`);
            }
        }
    );

    server.registerTool(
        "inspect_swagger_endpoint",
        {
            description: "Inspect a Swagger endpoint by operationId or path+method, including request/response schemas and optionally referenced schema definitions.",
            inputSchema: {
                operationId: z.string().min(1).optional(),
                path: z.string().min(1).optional(),
                method: z.string().min(1).optional(),
                includeSchemaDefinitions: z.boolean().optional(),
                forceRefresh: z.boolean().optional()
            }
        },
        async ({operationId, path, method, includeSchemaDefinitions, forceRefresh}) => {
            try {
                const latestSwagger = await loadLatestSwagger(forceRefresh);
                const entry = resolveEndpointByInput({
                    operationIndex,
                    swagger: latestSwagger,
                    operationId,
                    path,
                    method
                });
                return asToolResult(buildEndpointInspectionPayload({
                    swagger: latestSwagger,
                    entry,
                    includeSchemaDefinitions
                }));
            } catch (error) {
                return asToolResult(buildStructuredExecutionError(error, "swagger_inspection_error"));
            }
        }
    );

    server.registerTool(
        "get_schema",
        {
            description: "Get schema definition by name from Swagger components.",
            inputSchema: {
                name: z.string().min(1),
                forceRefresh: z.boolean().optional()
            }
        },
        async ({name, forceRefresh}) => {
            try {
                const latestSwagger = await loadLatestSwagger(forceRefresh);
                return asToolResult({schema: latestSwagger.components?.schemas?.[name] || null});
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
                keyword: z.string(),
                forceRefresh: z.boolean().optional()
            }
        },
        async ({keyword, forceRefresh}) => {
            const normalizedKeyword = String(keyword ?? "").trim();
            if (!normalizedKeyword) {
                return asToolResult({paths: []});
            }

            const latestSwagger = await loadLatestSwagger(forceRefresh);
            const searchKeyword = normalizedKeyword.toLowerCase();
            const paths = Object.keys(latestSwagger.paths || {}).filter((path) =>
                path.toLowerCase().includes(searchKeyword)
            );

            return asToolResult({paths});
        }
    );

    for (const [toolName, operationId] of resolvedDeterministicToolMappings.entries()) {
        const requiresBody = toolName === "update_profile";
        server.registerTool(
            toolName,
            {
                description: `Deterministic wrapper for Swagger operationId '${operationId}'.`,
                inputSchema: {
                    pathParams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
                    query: z.record(z.string(), z.unknown()).optional(),
                    ...(requiresBody ? {body: z.unknown()} : {})
                }
            },
            async ({pathParams = {}, query = {}, body}) => {
                try {
                    const result = await callApiBySwagger({
                        swaggerService,
                        authSession,
                        apiConfig,
                        fetchImpl,
                        operationIndex,
                        operationId,
                        pathParams,
                        query,
                        body
                    });

                    return asToolResult(result);
                } catch (error) {
                    if (getErrorMessage(error).includes("Unauthorized: call auth_login first")) {
                        return asToolResult(buildUnauthorizedResult());
                    }

                    return asToolResult({
                        ok: false,
                        error: {
                            kind: "mcp_execution_error",
                            message: getErrorMessage(error)
                        }
                    });
                }
            }
        );
    }

    const generatedOperationIds = [...operationIndex.keys()].sort((left, right) => left.localeCompare(right));
    const toolNameToOperationId = new Map();

    for (const operationId of generatedOperationIds) {
        const entry = operationIndex.get(operationId);
        const toolName = `api_${normalizeOperationId(operationId)}`;

        if (toolNameToOperationId.has(toolName)) {
            throw new Error(
                `Generated tool name collision: '${toolName}' maps to both '${toolNameToOperationId.get(toolName)}' and '${operationId}'.`
            );
        }

        toolNameToOperationId.set(toolName, operationId);
        registeredTools.push(toolName);

        server.registerTool(
            toolName,
            {
                description: entry.operation?.summary
                    ? `${entry.operation.summary} (resolved from Swagger operationId ${operationId})`
                    : `Call API operation by Swagger operationId ${operationId} with automatic auth handling.`,
                inputSchema: {
                    pathParams: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
                    query: z.record(z.string(), z.unknown()).optional(),
                    body: z.unknown().optional()
                }
            },
            async ({pathParams = {}, query = {}, body}) => {
                try {
                    const result = await executeOperation({
                        swaggerService,
                        authSession,
                        apiConfig,
                        fetchImpl,
                        path: entry.path,
                        method: entry.method,
                        pathItem: entry.pathItem,
                        operation: entry.operation,
                        pathParams,
                        query,
                        body
                    });

                    return asToolResult(result);
                } catch (error) {
                    if (getErrorMessage(error).includes("Unauthorized: call auth_login first")) {
                        return asToolResult({
                            ...buildUnauthorizedResult(),
                            operation: {
                                path: entry.path,
                                method: entry.method.toUpperCase(),
                                operationId
                            }
                        });
                    }

                    return asToolResult({
                        ok: false,
                        error: {
                            kind: "mcp_execution_error",
                            message: getErrorMessage(error)
                        },
                        operation: {
                            path: entry.path,
                            method: entry.method.toUpperCase(),
                            operationId
                        }
                    });
                }
            }
        );
    }

    return {
        registeredToolNames: registeredTools,
        authSession,
        diagnostics: {
            adaptiveMappingWarnings
        }
    };
}
