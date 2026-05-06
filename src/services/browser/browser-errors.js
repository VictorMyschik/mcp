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

    const finalUrl = normalizedError.details?.finalUrl || normalizedError.details?.url || fallbackUrl || null;
    if (finalUrl) {
        errorPayload.url = finalUrl;
        errorPayload.finalUrl = finalUrl;
    }

    if (normalizedError.details?.meta && typeof normalizedError.details.meta === "object") {
        errorPayload.meta = normalizedError.details.meta;
    }

    return {
        ok: false,
        error: errorPayload,
        ...(finalUrl ? {finalUrl} : {}),
        ...(debug?.screenshot ? {debugScreenshotPath: debug.screenshot} : {}),
        ...(debug?.html ? {debugHtmlPath: debug.html} : {}),
        ...(debug ? {debug} : {})
    };
}

