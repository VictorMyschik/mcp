import path from "node:path";
import {readFile} from "node:fs/promises";

import {getErrorMessage} from "../../utils/errors.js";

const JSON_CONTENT_TYPE_RE = /[/+]json($|;)/i;
const BODY_MODE_NAMES = ["jsonBody", "textBody", "multipart"];
const EXPECTED_RESPONSE_TYPES = new Set(["auto", "json", "text", "base64"]);

function hasOwnValue(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function cloneHeaders(headers = {}) {
    return Object.fromEntries(
        Object.entries(headers || {}).flatMap(([key, value]) => {
            if (!key) {
                return [];
            }

            if (Array.isArray(value)) {
                return [[key, value.map((item) => String(item)).join(", ")]];
            }

            if (value === undefined || value === null) {
                return [];
            }

            return [[key, String(value)]];
        })
    );
}

function getHeaderName(headers, lookupName) {
    const normalizedLookup = String(lookupName || "").trim().toLowerCase();
    return Object.keys(headers || {}).find((headerName) => headerName.toLowerCase() === normalizedLookup) || null;
}

function setHeaderIfMissing(headers, name, value) {
    if (!getHeaderName(headers, name)) {
        headers[name] = value;
    }
}

function deleteHeader(headers, name) {
    const headerName = getHeaderName(headers, name);
    if (headerName) {
        delete headers[headerName];
    }
}

function normalizeExpectedResponseType(expectedResponseType) {
    const normalized = String(expectedResponseType || "auto").trim().toLowerCase();
    if (!EXPECTED_RESPONSE_TYPES.has(normalized)) {
        throw new Error(`Unsupported expectedResponseType '${expectedResponseType}'. Allowed values: ${[...EXPECTED_RESPONSE_TYPES].join(", ")}`);
    }
    return normalized;
}

function resolveBodyMode({jsonBody, textBody, multipart}) {
    const providedModes = [
        jsonBody !== undefined ? "jsonBody" : null,
        textBody !== undefined ? "textBody" : null,
        multipart !== undefined ? "multipart" : null
    ].filter(Boolean);
    if (providedModes.length > 1) {
        throw new Error(`Only one request body mode is allowed. Received: ${providedModes.join(", ")}`);
    }

    if (providedModes.length === 0) {
        return "none";
    }

    switch (providedModes[0]) {
        case "jsonBody":
            return "json";
        case "textBody":
            return "text";
        case "multipart":
            return "multipart";
        default:
            return "none";
    }
}

function responseHeadersToObject(headers) {
    return Object.fromEntries(headers.entries());
}

function detectResponseType({expectedResponseType, contentType, parseError}) {
    if (expectedResponseType !== "auto") {
        return expectedResponseType;
    }

    if (JSON_CONTENT_TYPE_RE.test(contentType)) {
        return parseError ? "text" : "json";
    }

    return "text";
}

function deriveErrorMessage({status, statusText, parsedBody, rawBody, parseError}) {
    if (parsedBody && typeof parsedBody === "object") {
        if (typeof parsedBody.message === "string" && parsedBody.message.trim()) {
            return parsedBody.message;
        }
        if (typeof parsedBody.error === "string" && parsedBody.error.trim()) {
            return parsedBody.error;
        }
    }

    if (typeof parsedBody === "string" && parsedBody.trim()) {
        return parsedBody;
    }

    if (typeof rawBody === "string" && rawBody.trim()) {
        return rawBody;
    }

    if (parseError) {
        return `Unable to parse response body as JSON: ${parseError}`;
    }

    return `${status} ${statusText || "HTTP error"}`.trim();
}

export function resolvePathTemplate(pathTemplate, pathParams) {
    const missingPathParams = [];

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

export function appendQueryParams(url, query) {
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

export function buildRequestUrl({url, baseUrl, path: requestPath, pathParams = {}, query = {}}) {
    const hasUrl = Boolean(String(url || "").trim());
    const hasBaseUrl = Boolean(String(baseUrl || "").trim());
    const hasPath = Boolean(String(requestPath || "").trim());

    if (hasUrl && (hasBaseUrl || hasPath)) {
        throw new Error("Provide either 'url' or 'baseUrl' + 'path', not both.");
    }

    if (!hasUrl && !(hasBaseUrl && hasPath)) {
        throw new Error("Provide either absolute 'url' or both 'baseUrl' and 'path'.");
    }

    let requestUrl;
    if (hasUrl) {
        requestUrl = new URL(resolvePathTemplate(url, pathParams));
    } else {
        const resolvedPath = resolvePathTemplate(requestPath, pathParams);
        requestUrl = new URL(resolvedPath, baseUrl);
    }

    appendQueryParams(requestUrl, query);
    return requestUrl;
}

async function createFormEntry(field) {
    const name = String(field?.name || "").trim();
    if (!name) {
        throw new Error("Every multipart field requires a non-empty 'name'.");
    }

    const hasValue = hasOwnValue(field, "value");
    const hasFilePath = Boolean(String(field?.filePath || "").trim());
    const hasText = hasOwnValue(field, "text");
    const hasBase64 = Boolean(String(field?.base64 || "").trim());
    const specifiedKinds = [hasValue, hasFilePath, hasText, hasBase64].filter(Boolean).length;

    if (specifiedKinds === 0) {
        throw new Error(`Multipart field '${name}' requires one of: value, filePath, text, base64.`);
    }

    if (specifiedKinds > 1) {
        throw new Error(`Multipart field '${name}' must use exactly one of: value, filePath, text, base64.`);
    }

    if (hasValue) {
        return {
            name,
            value: String(field.value ?? ""),
            meta: {
                name,
                kind: "field",
                source: "value"
            }
        };
    }

    if (hasText) {
        if (!field.fileName && !field.contentType) {
            return {
                name,
                value: String(field.text ?? ""),
                meta: {
                    name,
                    kind: "field",
                    source: "text"
                }
            };
        }

        const buffer = Buffer.from(String(field.text ?? ""), "utf8");
        const fileName = String(field.fileName || `${name}.txt`).trim();
        return {
            name,
            value: new Blob([buffer], {type: String(field.contentType || "text/plain").trim() || "text/plain"}),
            fileName,
            meta: {
                name,
                kind: "file",
                source: "text",
                fileName,
                size: buffer.byteLength,
                contentType: String(field.contentType || "text/plain").trim() || "text/plain"
            }
        };
    }

    if (hasBase64) {
        const buffer = Buffer.from(String(field.base64 || ""), "base64");
        const fileName = String(field.fileName || `${name}.bin`).trim();
        const contentType = String(field.contentType || "application/octet-stream").trim() || "application/octet-stream";
        return {
            name,
            value: new Blob([buffer], {type: contentType}),
            fileName,
            meta: {
                name,
                kind: "file",
                source: "base64",
                fileName,
                size: buffer.byteLength,
                contentType
            }
        };
    }

    const filePath = String(field.filePath || "").trim();
    const buffer = await readFile(filePath);
    const fileName = String(field.fileName || path.basename(filePath)).trim() || `${name}.bin`;
    const contentType = String(field.contentType || "application/octet-stream").trim() || "application/octet-stream";
    return {
        name,
        value: new Blob([buffer], {type: contentType}),
        fileName,
        meta: {
            name,
            kind: "file",
            source: "filePath",
            fileName,
            filePath,
            size: buffer.byteLength,
            contentType
        }
    };
}

async function buildMultipartFormData(multipart) {
    const fields = Array.isArray(multipart?.fields) ? multipart.fields : [];
    if (fields.length === 0) {
        throw new Error("multipart.fields must contain at least one field.");
    }

    const formData = new FormData();
    const parts = [];

    for (const field of fields) {
        const entry = await createFormEntry(field);
        if (entry.fileName) {
            formData.append(entry.name, entry.value, entry.fileName);
        } else {
            formData.append(entry.name, entry.value);
        }
        parts.push(entry.meta);
    }

    return {formData, parts};
}

async function parseHttpResponseBody(response, {expectedResponseType = "auto", includeRawBody = false} = {}) {
    const normalizedExpectedResponseType = normalizeExpectedResponseType(expectedResponseType);
    const headers = responseHeadersToObject(response.headers);
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();

    if (normalizedExpectedResponseType === "base64") {
        const buffer = Buffer.from(await response.arrayBuffer());
        const base64Body = buffer.byteLength > 0 ? buffer.toString("base64") : null;
        return {
            status: response.status,
            statusText: response.statusText,
            ok: response.ok,
            headers,
            contentType,
            expectedResponseType: normalizedExpectedResponseType,
            detectedResponseType: "base64",
            body: base64Body,
            rawBody: includeRawBody ? base64Body : null,
            parseError: null,
            bodyLength: buffer.byteLength
        };
    }

    const rawBody = await response.text();
    if (!rawBody) {
        return {
            status: response.status,
            statusText: response.statusText,
            ok: response.ok,
            headers,
            contentType,
            expectedResponseType: normalizedExpectedResponseType,
            detectedResponseType: normalizedExpectedResponseType === "json" ? "json" : detectResponseType({expectedResponseType: normalizedExpectedResponseType, contentType, parseError: null}),
            body: null,
            rawBody: includeRawBody ? "" : null,
            parseError: null,
            bodyLength: 0
        };
    }

    const shouldParseJson = normalizedExpectedResponseType === "json"
        || (normalizedExpectedResponseType === "auto" && JSON_CONTENT_TYPE_RE.test(contentType));

    let parsedBody = rawBody;
    let parseError = null;

    if (shouldParseJson) {
        try {
            parsedBody = JSON.parse(rawBody);
        } catch (error) {
            parseError = getErrorMessage(error);
            parsedBody = rawBody;
        }
    }

    const detectedResponseType = detectResponseType({
        expectedResponseType: normalizedExpectedResponseType,
        contentType,
        parseError
    });

    return {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        headers,
        contentType,
        expectedResponseType: normalizedExpectedResponseType,
        detectedResponseType,
        body: parsedBody,
        rawBody: includeRawBody || parseError ? rawBody : null,
        parseError,
        bodyLength: Buffer.byteLength(rawBody, "utf8")
    };
}

export async function executeHttpRequest({
    fetchImpl,
    method,
    requestUrl,
    headers = {},
    jsonBody,
    textBody,
    multipart,
    timeoutMs = 15000,
    expectedResponseType = "auto",
    includeRawBody = false
}) {
    const normalizedMethod = String(method || "").trim().toUpperCase();
    if (!normalizedMethod) {
        throw new Error("HTTP method is required.");
    }

    const normalizedExpectedResponseType = normalizeExpectedResponseType(expectedResponseType);
    const resolvedTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
        ? Number(timeoutMs)
        : 15000;
    const requestHeaders = cloneHeaders(headers);
    const bodyMode = resolveBodyMode({jsonBody, textBody, multipart});
    const request = {
        method: normalizedMethod,
        url: requestUrl.toString(),
        timeoutMs: resolvedTimeoutMs,
        bodyMode
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), resolvedTimeoutMs);

    try {
        setHeaderIfMissing(requestHeaders, "accept", "application/json, text/plain;q=0.9, */*;q=0.8");

        let requestBody = undefined;
        if (bodyMode === "json") {
            requestBody = JSON.stringify(jsonBody);
            setHeaderIfMissing(requestHeaders, "content-type", "application/json");
        } else if (bodyMode === "text") {
            requestBody = String(textBody ?? "");
        } else if (bodyMode === "multipart") {
            const {formData, parts} = await buildMultipartFormData(multipart);
            deleteHeader(requestHeaders, "content-type");
            requestBody = formData;
            request.multipart = {parts};
        }

        const response = await fetchImpl(request.url, {
            method: normalizedMethod,
            headers: requestHeaders,
            body: requestBody,
            signal: controller.signal
        });
        const parsedResponse = await parseHttpResponseBody(response, {
            expectedResponseType: normalizedExpectedResponseType,
            includeRawBody
        });

        if (!response.ok) {
            return {
                ok: false,
                request,
                response: parsedResponse,
                error: {
                    kind: response.status === 401 ? "http_unauthorized" : "http_error",
                    status: response.status,
                    statusText: response.statusText,
                    message: deriveErrorMessage({
                        status: response.status,
                        statusText: response.statusText,
                        parsedBody: parsedResponse.body,
                        rawBody: parsedResponse.rawBody,
                        parseError: parsedResponse.parseError
                    }),
                    contentType: parsedResponse.contentType,
                    headers: parsedResponse.headers,
                    body: parsedResponse.body,
                    rawBody: parsedResponse.rawBody,
                    parseError: parsedResponse.parseError
                }
            };
        }

        return {
            ok: true,
            request,
            response: parsedResponse
        };
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            return {
                ok: false,
                request,
                error: {
                    kind: "timeout",
                    message: `Request timed out after ${resolvedTimeoutMs}ms.`,
                    timeoutMs: resolvedTimeoutMs
                }
            };
        }

        return {
            ok: false,
            request,
            error: {
                kind: "network_error",
                message: getErrorMessage(error)
            }
        };
    } finally {
        clearTimeout(timeout);
    }
}

