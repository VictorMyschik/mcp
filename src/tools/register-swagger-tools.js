import * as z from "zod/v4";
import fetch from "node-fetch";

import {createAuthSession} from "../services/auth/auth-session.js";
import {normalizeEndpoint} from "../services/swagger/normalize-endpoint.js";
import {getErrorMessage} from "../utils/errors.js";
import {asToolResult} from "./tool-result.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

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

function resolvePathTemplate(pathTemplate, pathParams) {
    const missingPathParams = [];

    const resolvedPath = String(pathTemplate ?? "").replace(/\{([^}]+)}/g, (_, key) => {
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

function parseResponseError(payload) {
    if (typeof payload === "string" && payload.trim()) {
        return payload;
    }
    if (payload && typeof payload === "object") {
        return payload.message || payload.error || JSON.stringify(payload);
    }
    return "Unknown error";
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
    const resolvedPath = resolvePathTemplate(path, pathParams);
    const requestUrl = new URL(resolvedPath, baseUrl);
    appendQueryParams(requestUrl, query);

    const swaggerRequiresAuth = Array.isArray(operation.security)
        ? operation.security.length > 0
        : Array.isArray(swagger.security) && swagger.security.length > 0;
    const requiresAuth = authMode === "required" ? true : swaggerRequiresAuth;

    async function sendRequest() {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), apiConfig.requestTimeoutMs);

        try {
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

            let serializedBody;
            if (body !== undefined) {
                serializedBody = JSON.stringify(body);
                requestHeaders["content-type"] = "application/json";
            }

            return await fetchImpl(requestUrl.toString(), {
                method: method.toUpperCase(),
                headers: requestHeaders,
                body: serializedBody,
                signal: controller.signal
            });
        } finally {
            clearTimeout(timeout);
        }
    }

    let response = await sendRequest();
    if (response.status === 401 && requiresAuth && apiConfig.retryOnUnauthorized && authMode !== "required") {
        await authSession.login();
        response = await sendRequest();
    }

    const parsedBody = await parseResponseBody(response);

    if (!response.ok) {
        if (response.status === 401) {
            return {
                ...buildUnauthorizedResult(),
                operation: {
                    path,
                    method: method.toUpperCase(),
                    operationId: operation.operationId || null
                }
            };
        }

        return {
            ok: false,
            error: {
                kind: "api_error",
                status: response.status,
                message: parseResponseError(parsedBody)
            },
            operation: {
                path,
                method: method.toUpperCase(),
                operationId: operation.operationId || null
            }
        };
    }

    return {
        ok: true,
        operation: {
            path,
            method: method.toUpperCase(),
            operationId: operation.operationId || null
        },
        data: parsedBody
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

export async function registerSwaggerTools(server, {
    swaggerService,
    authConfig,
    apiConfig,
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

    const authSession = createAuthSession({
        authConfig,
        fetchImpl,
        timeoutMs: apiConfig.requestTimeoutMs,
        buildBaseUrl: () => resolveBaseUrl({swagger, swaggerUrl: swaggerService.url})
    });

    const registeredTools = [
        "list_api_endpoints",
        "get_endpoint",
        "get_schema",
        "find_endpoint_by_keyword",
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
            inputSchema: {}
        },
        async () => {
            try {
                const latestSwagger = await swaggerService.loadSwagger();
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
                method: z.string().min(1)
            }
        },
        async ({path, method}) => {
            try {
                const latestSwagger = await swaggerService.loadSwagger();
                const normalizedMethod = String(method ?? "").toLowerCase();
                const endpoint = latestSwagger.paths?.[path]?.[normalizedMethod] || null;
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
                const latestSwagger = await swaggerService.loadSwagger();
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
                keyword: z.string()
            }
        },
        async ({keyword}) => {
            const normalizedKeyword = String(keyword ?? "").trim();
            if (!normalizedKeyword) {
                return asToolResult({paths: []});
            }

            const latestSwagger = await swaggerService.loadSwagger();
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
        diagnostics: {
            adaptiveMappingWarnings
        }
    };
}
