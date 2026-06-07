import assert from "node:assert/strict";
import test from "node:test";

import {getConfigFromEnv} from "../src/config/env.js";
import {registerSwaggerTools} from "../src/tools/register-swagger-tools.js";

class FakeMcpServer {
    constructor() {
        this.tools = new Map();
    }

    registerTool(name, _spec, handler) {
        this.tools.set(name, handler);
    }
}

function createMinimalSwagger() {
    return {
        openapi: "3.0.0",
        servers: [{url: "http://127.0.0.1:1"}],
        paths: {
            "/api/v1/ping": {
                get: {
                    operationId: "ping",
                    responses: {"200": {description: "ok"}}
                }
            },
            "/api/v1/users/{userId}": {
                get: {
                    operationId: "getUserProfile",
                    parameters: [{name: "userId", in: "path", required: true, schema: {type: "integer"}}],
                    responses: {"200": {description: "ok"}}
                }
            }
        }
    };
}

test("getConfigFromEnv defaults SWAGGER_GENERATED_API_TOOLS_ENABLED to true", () => {
    const config = getConfigFromEnv({SWAGGER_URL: "http://example.test/swagger.json"});
    assert.equal(config.tools.swagger.generatedApiToolsEnabled, true);
});

test("getConfigFromEnv disables generated api_* tools when SWAGGER_GENERATED_API_TOOLS_ENABLED=false", () => {
    const config = getConfigFromEnv({
        SWAGGER_URL: "http://example.test/swagger.json",
        SWAGGER_GENERATED_API_TOOLS_ENABLED: "false"
    });
    assert.equal(config.tools.swagger.generatedApiToolsEnabled, false);
});

test("registerSwaggerTools skips api_* registration in lite mode", async () => {
    const swagger = createMinimalSwagger();
    const swaggerService = {
        url: "http://127.0.0.1:1/swagger.json",
        loadSwagger: async () => swagger
    };
    const server = new FakeMcpServer();
    const registration = await registerSwaggerTools(server, {
        swaggerService,
        authConfig: {
            loginPath: "/api/v1/login",
            loginMethod: "post",
            usernameField: "login",
            passwordField: "password",
            tokenFieldPath: "content.accessToken",
            refreshTokenFieldPath: "content.refreshToken",
            tokenTypeFieldPath: "content.tokenType",
            defaultTokenType: "Bearer",
            staticToken: "",
            staticRefreshToken: "",
            username: "",
            password: "",
            autoLogin: false,
            internalTranslations: {
                token: "",
                tokenType: "Bearer"
            }
        },
        apiConfig: {
            requestTimeoutMs: 15000,
            retryOnUnauthorized: true
        },
        generatedApiToolsEnabled: false,
        fetchImpl: fetch
    });

    const apiTools = registration.registeredToolNames.filter((name) => name.startsWith("api_"));
    assert.deepEqual(apiTools, []);
    assert.ok(registration.registeredToolNames.includes("call_api_by_swagger"));
    assert.ok(registration.registeredToolNames.includes("call_api_raw"));
    assert.equal(registration.diagnostics.generatedApiToolsEnabled, false);
});
