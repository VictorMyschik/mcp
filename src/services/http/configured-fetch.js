import http from "node:http";
import https from "node:https";
import {readFileSync} from "node:fs";

import fetch from "node-fetch";

export function createConfiguredFetch({
    fetchImpl = fetch,
    tlsConfig = {}
} = {}) {
    let agentCache = null;

    function getAgents() {
        if (agentCache) {
            return agentCache;
        }

        const ca = tlsConfig.caCertPath
            ? readFileSync(tlsConfig.caCertPath, "utf8")
            : undefined;

        agentCache = {
            httpAgent: new http.Agent({keepAlive: true}),
            httpsAgent: new https.Agent({
                keepAlive: true,
                rejectUnauthorized: tlsConfig.rejectUnauthorized !== false,
                ...(ca ? {ca} : {})
            })
        };

        return agentCache;
    }

    const agentResolver = (parsedUrl) => {
        const protocol = String(parsedUrl?.protocol || "").toLowerCase();
        if (protocol === "http:") {
            return getAgents().httpAgent;
        }
        if (protocol === "https:") {
            return getAgents().httpsAgent;
        }
        return undefined;
    };

    return (url, options = {}) => fetchImpl(url, {
        ...options,
        agent: options.agent || agentResolver
    });
}

