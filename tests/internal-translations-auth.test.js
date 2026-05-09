import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {inspect} from "node:util";
import {once} from "node:events";
import {mkdtemp, rm, writeFile} from "node:fs/promises";

import {
    ENV_SOURCE_PRIORITY,
    getConfigFromEnv,
    resolveWorkspaceEnv
} from "../src/config/env.js";
import {createSwaggerService} from "../src/services/swagger/swagger-cache.js";
import {registerSwaggerTools} from "../src/tools/register-swagger-tools.js";

const VALID_LOGIN = "demo@example.com";
const VALID_PASSWORD = "secret";
const ACCESS_TOKEN = "access-token-demo";
const VALID_INTERNAL_TOKEN = "internal-token-valid";

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

function sendJson(response, statusCode, payload) {
    response.writeHead(statusCode, {"content-type": "application/json"});
    response.end(JSON.stringify(payload));
}

function readRequestBuffer(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        request.on("end", () => resolve(Buffer.concat(chunks)));
        request.on("error", reject);
    });
}

async function readJsonBody(request) {
    const buffer = await readRequestBuffer(request);
    if (!buffer.length) {
        return {};
    }
    return JSON.parse(buffer.toString("utf8"));
}

function createSwaggerDocument(baseUrl) {
    return {
        openapi: "3.0.0",
        info: {
            title: "Outvento internal translations test API",
            version: "1.0.0"
        },
        servers: [{url: baseUrl}],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: "http",
                    scheme: "bearer"
                }
            }
        },
        paths: {
            "/api/v1/login": {
                post: {
                    operationId: "login",
                    requestBody: {
                        required: true,
                        content: {
                            "application/json": {
                                schema: {type: "object"}
                            }
                        }
                    },
                    responses: {
                        "200": {
                            description: "Login response"
                        }
                    }
                }
            },
            "/api/v1/users/{userId}": {
                get: {
                    operationId: "getUserProfile",
                    security: [{bearerAuth: []}],
                    parameters: [
                        {
                            name: "userId",
                            in: "path",
                            required: true,
                            schema: {type: "integer"}
                        }
                    ],
                    responses: {
                        "200": {
                            description: "Regular protected endpoint"
                        }
                    }
                }
            },
            "/api/v1/internal/translations/{locale}/{file}": {
                get: {
                    operationId: "getInternalTranslations",
                    parameters: [
                        {
                            name: "locale",
                            in: "path",
                            required: true,
                            schema: {type: "string"}
                        },
                        {
                            name: "file",
                            in: "path",
                            required: true,
                            schema: {type: "string"}
                        }
                    ],
                    responses: {
                        "200": {
                            description: "Internal translations file"
                        }
                    }
                }
            },
            "/api/v1/internal/translations/merge": {
                post: {
                    operationId: "mergeInternalTranslations",
                    requestBody: {
                        required: true,
                        content: {
                            "application/json": {
                                schema: {type: "object"}
                            }
                        }
                    },
                    responses: {
                        "200": {
                            description: "Merge internal translations"
                        }
                    }
                }
            }
        }
    };
}

async function startFixtureServer() {
    const counters = {
        internalGet: 0,
        internalMerge: 0,
        userProfile: 0
    };

    const server = http.createServer(async (request, response) => {
        const requestUrl = new URL(request.url || "/", `http://${request.headers.host}`);
        const authorization = String(request.headers.authorization || "");

        if (request.method === "GET" && requestUrl.pathname === "/swagger.json") {
            sendJson(response, 200, createSwaggerDocument(`http://${request.headers.host}`));
            return;
        }

        if (request.method === "POST" && requestUrl.pathname === "/api/v1/login") {
            const body = await readJsonBody(request);
            if (body.login === VALID_LOGIN && body.password === VALID_PASSWORD) {
                sendJson(response, 200, {
                    content: {
                        accessToken: ACCESS_TOKEN,
                        refreshToken: "refresh-token-demo",
                        tokenType: "Bearer"
                    }
                });
                return;
            }

            sendJson(response, 401, {message: "Invalid credentials"});
            return;
        }

        if (request.method === "GET" && /^\/api\/v1\/users\/\d+$/.test(requestUrl.pathname)) {
            counters.userProfile += 1;
            if (authorization !== `Bearer ${ACCESS_TOKEN}`) {
                sendJson(response, 401, {message: "Unauthorized"});
                return;
            }

            sendJson(response, 200, {
                content: {
                    userId: Number(requestUrl.pathname.split("/").pop()),
                    authorization
                }
            });
            return;
        }

        if (request.method === "GET" && /^\/api\/v1\/internal\/translations\/[^/]+\/[^/]+$/.test(requestUrl.pathname)) {
            counters.internalGet += 1;
            if (authorization !== `Bearer ${VALID_INTERNAL_TOKEN}`) {
                sendJson(response, 403, {message: "Invalid internal API token."});
                return;
            }

            const [locale, file] = requestUrl.pathname.split("/").slice(-2);
            sendJson(response, 200, {
                content: {
                    locale,
                    file,
                    authorization
                }
            });
            return;
        }

        if (request.method === "POST" && requestUrl.pathname === "/api/v1/internal/translations/merge") {
            counters.internalMerge += 1;
            if (authorization !== `Bearer ${VALID_INTERNAL_TOKEN}`) {
                sendJson(response, 403, {message: "Invalid internal API token."});
                return;
            }

            const body = await readJsonBody(request);
            sendJson(response, 200, {
                ok: true,
                received: body,
                authorization
            });
            return;
        }

        sendJson(response, 404, {message: "Not found"});
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    return {
        server,
        baseUrl,
        swaggerUrl: `${baseUrl}/swagger.json`,
        counters
    };
}

async function createRegisteredSwaggerTools(envOverrides = {}) {
    const fixture = await startFixtureServer();
    const fakeServer = new FakeMcpServer();
    const config = getConfigFromEnv({
        SWAGGER_URL: fixture.swaggerUrl,
        AUTH_USERNAME: VALID_LOGIN,
        AUTH_PASSWORD: VALID_PASSWORD,
        API_REQUEST_TIMEOUT_MS: "5000",
        API_RETRY_ON_UNAUTHORIZED: "true",
        ...envOverrides
    });

    await registerSwaggerTools(fakeServer, {
        swaggerService: createSwaggerService({swaggerUrl: fixture.swaggerUrl}),
        authConfig: config.auth,
        apiConfig: config.api
    });

    return {
        fixture,
        fakeServer,
        config,
        async close() {
            await new Promise((resolve) => fixture.server.close(resolve));
        }
    };
}

test("resolveWorkspaceEnv applies .env < .env.local < process.env priority", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "outvento-env-priority-"));

    try {
        await writeFile(path.join(tempDir, ".env"), [
            "INTERNAL_TRANSLATION_API_TOKEN=from-dotenv",
            "AUTH_TOKEN=legacy-dotenv"
        ].join("\n"), "utf8");
        await writeFile(path.join(tempDir, ".env.local"), [
            "INTERNAL_TRANSLATION_API_TOKEN=from-dotenv-local"
        ].join("\n"), "utf8");

        const resolved = resolveWorkspaceEnv({
            cwd: tempDir,
            processEnv: {
                SWAGGER_URL: "http://localhost/swagger.json",
                INTERNAL_TRANSLATION_API_TOKEN: "from-process-env"
            }
        });

        assert.equal(resolved.env.INTERNAL_TRANSLATION_API_TOKEN, "from-process-env");
        assert.equal(resolved.sourceByKey.INTERNAL_TRANSLATION_API_TOKEN, ENV_SOURCE_PRIORITY[0]);
    } finally {
        await rm(tempDir, {recursive: true, force: true});
    }
});

test("getConfigFromEnv prefers dedicated internal translation token over AUTH_TOKEN fallback", () => {
    const config = getConfigFromEnv({
        SWAGGER_URL: "http://localhost/swagger.json",
        AUTH_TOKEN: "legacy-auth-token",
        INTERNAL_TRANSLATION_API_TOKEN: "dedicated-internal-token"
    }, {
        sourceByKey: {
            AUTH_TOKEN: "process.env",
            INTERNAL_TRANSLATION_API_TOKEN: ".env.local"
        }
    });

    assert.equal(config.auth.internalTranslations.token, "dedicated-internal-token");
    assert.equal(config.auth.internalTranslations.tokenEnvVar, "INTERNAL_TRANSLATION_API_TOKEN");
    assert.equal(config.auth.internalTranslations.tokenSource, ".env.local");
});

test("internal translations tools succeed with a valid configured token and emit masked debug logs", async () => {
    let sandbox = null;
    const originalDebug = console.debug;
    const debugMessages = [];
    console.debug = (...args) => {
        debugMessages.push(args.map((value) => typeof value === "string" ? value : inspect(value, {depth: null})).join(" "));
    };

    try {
        sandbox = await createRegisteredSwaggerTools({
            INTERNAL_TRANSLATION_API_TOKEN: VALID_INTERNAL_TOKEN,
            API_DEBUG: "true"
        });

        const getResult = await sandbox.fakeServer.call("api_get_internal_translations", {
            pathParams: {
                locale: "en",
                file: "common"
            }
        });
        assert.equal(getResult.ok, true);
        assert.equal(getResult.data.content.locale, "en");
        assert.equal(getResult.data.content.file, "common");
        assert.equal(getResult.data.content.authorization, `Bearer ${VALID_INTERNAL_TOKEN}`);

        const mergeResult = await sandbox.fakeServer.call("api_merge_internal_translations", {
            body: {
                locale: "en",
                files: ["common"]
            }
        });
        assert.equal(mergeResult.ok, true);
        assert.equal(mergeResult.data.ok, true);
        assert.deepEqual(mergeResult.data.received, {
            locale: "en",
            files: ["common"]
        });
        assert.equal(mergeResult.data.authorization, `Bearer ${VALID_INTERNAL_TOKEN}`);

        const profileResult = await sandbox.fakeServer.call("api_get_user_profile", {
            pathParams: {
                userId: 42
            }
        });
        assert.equal(profileResult.ok, true);
        assert.equal(profileResult.data.content.authorization, `Bearer ${ACCESS_TOKEN}`);

        assert.equal(sandbox.fixture.counters.internalGet, 1);
        assert.equal(sandbox.fixture.counters.internalMerge, 1);
        assert.equal(sandbox.fixture.counters.userProfile, 1);

        assert.ok(debugMessages.some((line) => line.includes("Internal translations token source resolved.")));
        assert.ok(debugMessages.some((line) => line.includes("Internal translations Authorization header formed.")));
        assert.ok(debugMessages.some((line) => line.includes("len=") && line.includes("sha256=")));
        assert.ok(debugMessages.every((line) => !line.includes(VALID_INTERNAL_TOKEN)));
    } finally {
        console.debug = originalDebug;
        await sandbox?.close();
    }
});

test("internal translations tools fail clearly when token is missing", async () => {
    const sandbox = await createRegisteredSwaggerTools();

    try {
        const result = await sandbox.fakeServer.call("api_get_internal_translations", {
            pathParams: {
                locale: "en",
                file: "common"
            }
        });

        assert.equal(result.ok, false);
        assert.equal(result.error.kind, "internal_translation_auth_error");
        assert.match(result.error.message, /Missing internal translations token/i);
        assert.equal(sandbox.fixture.counters.internalGet, 0);
    } finally {
        await sandbox.close();
    }
});

test("internal translations tools propagate 403 for an invalid configured token", async () => {
    const sandbox = await createRegisteredSwaggerTools({
        INTERNAL_TRANSLATION_API_TOKEN: "internal-token-invalid"
    });

    try {
        const result = await sandbox.fakeServer.call("api_merge_internal_translations", {
            body: {
                locale: "en"
            }
        });

        assert.equal(result.ok, false);
        assert.equal(result.error.status, 403);
        assert.equal(result.error.message, "Invalid internal API token.");
        assert.equal(sandbox.fixture.counters.internalMerge, 1);
    } finally {
        await sandbox.close();
    }
});



