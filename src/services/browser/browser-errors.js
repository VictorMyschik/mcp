import {getErrorMessage} from "../../utils/errors.js";

export class BrowserToolError extends Error {
    constructor(code, message, details = {}) {
        super(message);
        this.name = "BrowserToolError";
        this.code = code;
        this.details = details;
    }
}

export function browserError(code, message, details = {}) {
    return new BrowserToolError(code, message, details);
}

export function isBrowserToolError(error) {
    return error instanceof BrowserToolError;
}

export function toBrowserErrorPayload(error, {debug, fallbackUrl} = {}) {
    const normalizedError = isBrowserToolError(error)
        ? error
        : new BrowserToolError("BROWSER_TOOL_ERROR", getErrorMessage(error));

    const errorPayload = {
        code: normalizedError.code,
        message: normalizedError.message
    };

    const url = normalizedError.details?.url || fallbackUrl || null;
    if (url) {
        errorPayload.url = url;
    }

    if (normalizedError.details?.meta && typeof normalizedError.details.meta === "object") {
        errorPayload.meta = normalizedError.details.meta;
    }

    return {
        ok: false,
        error: errorPayload,
        ...(debug ? {debug} : {})
    };
}

