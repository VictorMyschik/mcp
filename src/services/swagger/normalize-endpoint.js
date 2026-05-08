export function extractSchemaName(ref) {
    if (typeof ref !== "string" || !ref.trim()) {
        return null;
    }

    const trimmed = ref.trim();
    const segments = trimmed.split("/");
    return segments[segments.length - 1] || null;
}

function toInlineSchema(schema) {
    if (!schema || typeof schema !== "object") {
        return null;
    }

    if (schema.$ref) {
        return null;
    }

    return schema;
}

function normalizeSchemaInfo(schema) {
    if (!schema || typeof schema !== "object") {
        return {
            type: "unknown",
            schema: null,
            inlineSchema: null,
            itemsSchema: null
        };
    }

    const directRef = extractSchemaName(schema.$ref);
    if (directRef) {
        return {
            type: schema.type || "object",
            schema: directRef,
            inlineSchema: null,
            itemsSchema: null
        };
    }

    if (schema.type === "array") {
        const itemRef = extractSchemaName(schema.items?.$ref);
        return {
            type: "array",
            schema: itemRef,
            inlineSchema: toInlineSchema(schema),
            itemsSchema: itemRef
                ? {
                    type: schema.items?.type || "object",
                    schema: itemRef,
                    inlineSchema: null
                }
                : normalizeSchemaInfo(schema.items)
        };
    }

    return {
        type: schema.type || "unknown",
        schema: null,
        inlineSchema: toInlineSchema(schema),
        itemsSchema: null
    };
}

function normalizeParameter(parameter) {
    const schemaInfo = normalizeSchemaInfo(parameter?.schema || null);
    return {
        name: parameter?.name || "",
        in: parameter?.in || "unknown",
        required: Boolean(parameter?.required),
        description: parameter?.description ?? null,
        type: parameter?.schema?.type || parameter?.type || schemaInfo.type || "unknown",
        schema: schemaInfo.schema,
        inlineSchema: schemaInfo.inlineSchema
    };
}

function combineParameters(pathItem, operation) {
    const combined = [
        ...(Array.isArray(pathItem?.parameters) ? pathItem.parameters : []),
        ...(Array.isArray(operation?.parameters) ? operation.parameters : [])
    ];

    return combined.filter((parameter) => {
        const location = parameter?.in;
        return location === "query" || location === "path" || location === "header" || location === "cookie" || location === "body";
    });
}

function normalizeParams(pathItem, operation) {
    return combineParameters(pathItem, operation).map(normalizeParameter);
}

function normalizeMediaContent(content) {
    const normalizedEntries = Object.entries(content || {}).map(([contentType, mediaType]) => {
        const schemaInfo = normalizeSchemaInfo(mediaType?.schema);
        return [contentType, {
            type: schemaInfo.type,
            schema: schemaInfo.schema,
            inlineSchema: schemaInfo.inlineSchema,
            itemsSchema: schemaInfo.itemsSchema,
            example: mediaType?.example ?? null,
            hasExamples: Boolean(mediaType?.examples && Object.keys(mediaType.examples).length > 0)
        }];
    });

    return Object.fromEntries(normalizedEntries);
}

function normalizeRequestBody(requestBody) {
    if (!requestBody || typeof requestBody !== "object") {
        return null;
    }

    const content = normalizeMediaContent(requestBody.content || {});
    const contentTypes = Object.keys(content);
    const jsonBody = content["application/json"] || content[contentTypes[0]] || null;
    return {
        required: Boolean(requestBody.required),
        description: requestBody.description ?? null,
        contentTypes,
        content,
        type: jsonBody?.type || "unknown",
        schema: jsonBody?.schema || null,
        inlineSchema: jsonBody?.inlineSchema || null
    };
}

function pickResponse(responses) {
    if (!responses || typeof responses !== "object") {
        return null;
    }

    return responses["200"] || responses["201"] || responses[Object.keys(responses)[0]] || null;
}

function normalizeResponse(responses) {
    const selectedResponse = pickResponse(responses);
    if (!selectedResponse) {
        return null;
    }

    const content = selectedResponse.content || {};
    const jsonContent = content["application/json"];
    const fallbackContent = jsonContent || content[Object.keys(content)[0]];

    if (!fallbackContent) {
        return {
            type: "unknown",
            schema: null,
            inlineSchema: null,
            contentTypes: []
        };
    }

    const schemaInfo = normalizeSchemaInfo(fallbackContent.schema);
    return {
        type: schemaInfo.type,
        schema: schemaInfo.schema,
        inlineSchema: schemaInfo.inlineSchema,
        contentTypes: Object.keys(content)
    };
}

function normalizeResponses(responses) {
    return Object.entries(responses || {}).map(([statusCode, response]) => ({
        statusCode,
        description: response?.description ?? null,
        contentTypes: Object.keys(response?.content || {}),
        content: normalizeMediaContent(response?.content || {})
    }));
}

export function collectEndpointSchemaNames(endpoint) {
    const schemaNames = new Set();

    for (const parameter of endpoint?.params || []) {
        if (parameter?.schema) {
            schemaNames.add(parameter.schema);
        }
    }

    if (endpoint?.requestBody?.schema) {
        schemaNames.add(endpoint.requestBody.schema);
    }
    for (const content of Object.values(endpoint?.requestBody?.content || {})) {
        if (content?.schema) {
            schemaNames.add(content.schema);
        }
        if (content?.itemsSchema?.schema) {
            schemaNames.add(content.itemsSchema.schema);
        }
    }

    if (endpoint?.response?.schema) {
        schemaNames.add(endpoint.response.schema);
    }
    for (const response of endpoint?.responses || []) {
        for (const content of Object.values(response?.content || {})) {
            if (content?.schema) {
                schemaNames.add(content.schema);
            }
            if (content?.itemsSchema?.schema) {
                schemaNames.add(content.itemsSchema.schema);
            }
        }
    }

    return [...schemaNames].filter(Boolean).sort((left, right) => left.localeCompare(right));
}

export function normalizeEndpoint(endpoint, path, method, pathItem) {
    if (!endpoint || typeof endpoint !== "object") {
        return null;
    }

    const params = normalizeParams(pathItem, endpoint);
    return {
        path: String(path ?? ""),
        method: String(method ?? "").toLowerCase(),
        operationId: endpoint.operationId ?? null,
        summary: endpoint.summary ?? null,
        description: endpoint.description ?? null,
        tags: Array.isArray(endpoint.tags) ? endpoint.tags : [],
        deprecated: Boolean(endpoint.deprecated),
        params,
        requiredParams: params.filter((parameter) => parameter.required),
        requestBody: normalizeRequestBody(endpoint.requestBody),
        response: normalizeResponse(endpoint.responses),
        responses: normalizeResponses(endpoint.responses),
        security: Array.isArray(endpoint.security) ? endpoint.security : []
    };
}

