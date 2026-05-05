export function extractSchemaName(ref) {
    if (typeof ref !== "string" || !ref.trim()) {
        return null;
    }

    const trimmed = ref.trim();
    const segments = trimmed.split("/");
    return segments[segments.length - 1] || null;
}

function normalizeSchemaInfo(schema) {
    if (!schema || typeof schema !== "object") {
        return {
            type: "unknown",
            schema: null
        };
    }

    const directRef = extractSchemaName(schema.$ref);
    if (directRef) {
        return {
            type: schema.type || "object",
            schema: directRef
        };
    }

    if (schema.type === "array") {
        const itemRef = extractSchemaName(schema.items?.$ref);
        return {
            type: "array",
            schema: itemRef
        };
    }

    return {
        type: schema.type || "unknown",
        schema: null
    };
}

function normalizeParams(parameters) {
    if (!Array.isArray(parameters)) {
        return [];
    }

    return parameters
        .filter((parameter) => {
            const location = parameter?.in;
            return location === "query" || location === "path" || location === "body";
        })
        .map((parameter) => ({
            name: parameter?.name || "",
            in: parameter.in,
            required: Boolean(parameter?.required),
            type: parameter?.schema?.type || parameter?.type || "unknown"
        }));
}

function normalizeRequestBody(requestBody) {
    const jsonBody = requestBody?.content?.["application/json"];
    if (!jsonBody) {
        return null;
    }

    const schemaInfo = normalizeSchemaInfo(jsonBody.schema);
    return {
        type: schemaInfo.type,
        schema: schemaInfo.schema
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
            schema: null
        };
    }

    const schemaInfo = normalizeSchemaInfo(fallbackContent.schema);
    return {
        type: schemaInfo.type,
        schema: schemaInfo.schema
    };
}

export function normalizeEndpoint(endpoint, path, method) {
    if (!endpoint || typeof endpoint !== "object") {
        return null;
    }

    return {
        path: String(path ?? ""),
        method: String(method ?? "").toLowerCase(),
        summary: endpoint.summary ?? null,
        params: normalizeParams(endpoint.parameters),
        requestBody: normalizeRequestBody(endpoint.requestBody),
        response: normalizeResponse(endpoint.responses)
    };
}

