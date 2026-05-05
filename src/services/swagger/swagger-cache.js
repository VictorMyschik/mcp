import fetch from "node-fetch";

import {getErrorMessage} from "../../utils/errors.js";

export function createSwaggerService({swaggerUrl, fetchImpl = fetch}) {
    let swaggerCache = null;

    async function loadSwagger({forceRefresh = false} = {}) {
        if (!swaggerCache || forceRefresh) {
            const response = await fetchImpl(swaggerUrl);
            if (!response.ok) {
                throw new Error(`Swagger request failed: ${response.status} ${response.statusText}`);
            }

            let parsed;
            try {
                parsed = await response.json();
            } catch (error) {
                throw new Error(`Swagger response is not valid JSON: ${getErrorMessage(error)}`);
            }

            if (!parsed || typeof parsed !== "object" || typeof parsed.paths !== "object") {
                throw new Error("Swagger schema is invalid: expected object with 'paths'");
            }

            swaggerCache = parsed;
        }

        return swaggerCache;
    }

    return {
        loadSwagger,
        url: swaggerUrl
    };
}

