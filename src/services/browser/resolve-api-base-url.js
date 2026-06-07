export function resolveApiBaseUrl({frontendOrigin, swaggerUrl} = {}) {
    if (swaggerUrl) {
        try {
            return new URL(String(swaggerUrl).trim()).origin;
        } catch {
            // fall through
        }
    }

    if (!frontendOrigin) {
        return null;
    }

    try {
        const url = new URL(String(frontendOrigin).trim());
        if (url.hostname.startsWith("api.")) {
            return url.origin;
        }

        url.hostname = `api.${url.hostname}`;
        return url.origin;
    } catch {
        return null;
    }
}
