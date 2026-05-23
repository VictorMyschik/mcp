import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {mkdtemp, rm, writeFile} from "node:fs/promises";

import {getConfigFromEnv} from "../src/config/env.js";
import {createConfiguredFetch} from "../src/services/http/configured-fetch.js";
import {registerHealthTool} from "../src/tools/register-health-tool.js";

class FakeMcpServer {
    constructor() {
        this.tools = new Map();
    }

    registerTool(name, _spec, handler) {
        this.tools.set(name, handler);
    }

    async call(name, input = {}) {
        const handler = this.tools.get(name);
        if (!handler) {
            throw new Error(`Tool '${name}' is not registered.`);
        }

        const result = await handler(input);
        return result.structuredContent;
    }
}

test("getConfigFromEnv resolves HTTPS/TLS settings and Swagger aliases", () => {
    const config = getConfigFromEnv({
        SWAGGER_URL: "https://api.outvento.test/docs?api-docs.json",
        SWAGGER_TLS_INSECURE_SKIP_VERIFY: "true",
        SWAGGER_TLS_CA_CERT_PATH: "/tmp/outvento-root-ca.pem"
    });

    assert.equal(config.api.tls.rejectUnauthorized, false);
    assert.equal(config.api.tls.caCertPath, "/tmp/outvento-root-ca.pem");

    const explicitConfig = getConfigFromEnv({
        SWAGGER_URL: "https://api.outvento.test/docs?api-docs.json",
        API_TLS_REJECT_UNAUTHORIZED: "true",
        API_TLS_INSECURE_SKIP_VERIFY: "true"
    });

    assert.equal(explicitConfig.api.tls.rejectUnauthorized, true);
});

test("createConfiguredFetch injects protocol-aware agents with TLS overrides", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "outvento-configured-fetch-"));
    const caCertPath = path.join(tempDir, "root-ca.pem");
    let captured = null;

    try {
        await writeFile(caCertPath, "dummy-root-ca", "utf8");
        const configuredFetch = createConfiguredFetch({
            tlsConfig: {
                rejectUnauthorized: false,
                caCertPath
            },
            fetchImpl: async (url, options) => {
                captured = {url, options};
                return {ok: true, url, options};
            }
        });

        const result = await configuredFetch("https://api.outvento.test/docs?api-docs.json", {
            headers: {
                accept: "application/json"
            }
        });

        assert.equal(result.ok, true);
        assert.ok(captured);
        assert.equal(typeof captured.options.agent, "function");

        const httpsAgent = captured.options.agent(new URL("https://api.outvento.test/docs?api-docs.json"));
        const httpAgent = captured.options.agent(new URL("http://api.outvento.test/docs?api-docs.json"));

        assert.ok(httpsAgent instanceof https.Agent);
        assert.ok(httpAgent instanceof http.Agent);
        assert.equal(httpsAgent.options.rejectUnauthorized, false);
        assert.equal(httpsAgent.options.ca, "dummy-root-ca");
    } finally {
        await rm(tempDir, {recursive: true, force: true});
    }
});

test("health reports Swagger registration failures instead of missing env", async () => {
    const server = new FakeMcpServer();
    const runtimeError = "request to https://api.outvento.test/docs?api-docs.json failed, reason: unable to verify the first certificate";

    registerHealthTool(server, {
        dbClient: null,
        swaggerService: null,
        swaggerAvailability: {
            enabled: false,
            missingEnvVars: [],
            runtimeError
        },
        swaggerUrl: "https://api.outvento.test/docs?api-docs.json",
        browserAvailability: {
            enabled: true
        },
        browserConfig: {
            artifactsDir: "/tmp/browser-artifacts",
            sessionTtlMs: 60000
        }
    });

    const health = await server.call("health");

    assert.equal(health.status, "degraded");
    assert.equal(health.swagger.ok, false);
    assert.equal(health.swagger.enabled, false);
    assert.equal(health.swagger.reason, "registration_failed");
    assert.equal(health.swagger.error, runtimeError);
    assert.equal(health.swagger.runtimeError, runtimeError);
    assert.equal(health.swagger.url, "https://api.outvento.test/docs?api-docs.json");
});

