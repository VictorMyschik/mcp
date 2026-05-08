import assert from "node:assert/strict";
import {once} from "node:events";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {createSwaggerService} from "../src/services/swagger/swagger-cache.js";
import {registerSwaggerTools} from "../src/tools/register-swagger-tools.js";

const VALID_LOGIN = "demo@example.com";
const VALID_PASSWORD = "secret";
const ACCESS_TOKEN = "access-token-demo";
const REFRESH_TOKEN = "refresh-token-demo";

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

function sendText(response, statusCode, text) {
    response.writeHead(statusCode, {"content-type": "text/plain; charset=utf-8"});
    response.end(text);
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

function parseMultipartForm(buffer, contentTypeHeader) {
    const boundaryMatch = /boundary=([^;]+)/i.exec(String(contentTypeHeader || ""));
    if (!boundaryMatch) {
        return {fields: {}, files: []};
    }

    const boundary = `--${boundaryMatch[1]}`;
    const raw = buffer.toString("latin1");
    const parts = raw
        .split(boundary)
        .map((part) => part.trim())
        .filter((part) => part && part !== "--");

    const fields = {};
    const files = [];

    for (const part of parts) {
        const [rawHeaders, ...contentParts] = part.split("\r\n\r\n");
        if (!rawHeaders || contentParts.length === 0) {
            continue;
        }

        const content = contentParts.join("\r\n\r\n").replace(/\r\n--$/, "").replace(/\r\n$/, "");
        const disposition = rawHeaders.split("\r\n").find((line) => line.toLowerCase().startsWith("content-disposition:")) || "";
        const contentType = rawHeaders.split("\r\n").find((line) => line.toLowerCase().startsWith("content-type:")) || "";
        const nameMatch = /name="([^"]+)"/i.exec(disposition);
        const fileNameMatch = /filename="([^"]+)"/i.exec(disposition);
        const fieldName = nameMatch?.[1] || null;

        if (!fieldName) {
            continue;
        }

        if (fileNameMatch) {
            files.push({
                fieldName,
                fileName: fileNameMatch[1],
                contentType: contentType.split(":")[1]?.trim() || null,
                content,
                size: Buffer.byteLength(content, "latin1")
            });
        } else {
            fields[fieldName] = content;
        }
    }

    return {fields, files};
}

function createSwaggerDocument(baseUrl) {
    return {
        openapi: "3.0.0",
        info: {
            title: "Outvento smoke API",
            version: "1.0.0"
        },
        servers: [
            {
                url: baseUrl
            }
        ],
        components: {
            securitySchemes: {
                bearerAuth: {
                    type: "http",
                    scheme: "bearer"
                }
            },
            schemas: {
                UserProfileResponse: {
                    type: "object",
                    required: ["content"],
                    properties: {
                        content: {
                            type: "object",
                            properties: {
                                userId: {type: "integer"},
                                details: {type: "string"}
                            }
                        }
                    }
                },
                AvatarUploadRequest: {
                    type: "object",
                    required: ["avatar"],
                    properties: {
                        avatar: {
                            type: "string",
                            format: "binary"
                        },
                        folder: {
                            type: "string"
                        }
                    }
                },
                AvatarUploadResponse: {
                    type: "object",
                    properties: {
                        ok: {type: "boolean"},
                        filesCount: {type: "integer"}
                    }
                }
            }
        },
        paths: {
            "/api/v1/users/{userId}": {
                get: {
                    operationId: "getUserProfile",
                    summary: "Get user profile",
                    security: [{bearerAuth: []}],
                    parameters: [
                        {
                            name: "userId",
                            in: "path",
                            required: true,
                            schema: {type: "integer"}
                        },
                        {
                            name: "details",
                            in: "query",
                            required: true,
                            schema: {type: "string"}
                        }
                    ],
                    responses: {
                        "200": {
                            description: "Profile payload",
                            content: {
                                "application/json": {
                                    schema: {
                                        $ref: "#/components/schemas/UserProfileResponse"
                                    }
                                }
                            }
                        }
                    }
                }
            },
            "/api/v1/upload-avatar": {
                post: {
                    operationId: "saveUserAvatar",
                    summary: "Upload avatar",
                    security: [{bearerAuth: []}],
                    requestBody: {
                        required: true,
                        content: {
                            "multipart/form-data": {
                                schema: {
                                    $ref: "#/components/schemas/AvatarUploadRequest"
                                }
                            }
                        }
                    },
                    responses: {
                        "200": {
                            description: "Upload result",
                            content: {
                                "application/json": {
                                    schema: {
                                        $ref: "#/components/schemas/AvatarUploadResponse"
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    };
}

async function startFixtureServer() {
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
                        refreshToken: REFRESH_TOKEN,
                        tokenType: "Bearer"
                    }
                });
                return;
            }

            sendJson(response, 401, {message: "Invalid credentials"});
            return;
        }

        if (request.method === "GET" && requestUrl.pathname.startsWith("/api/v1/raw-echo/")) {
            sendJson(response, 200, {
                path: requestUrl.pathname,
                query: Object.fromEntries(requestUrl.searchParams.entries()),
                queryAll: Object.fromEntries([...requestUrl.searchParams.keys()].map((key) => [key, requestUrl.searchParams.getAll(key)])),
                headers: {
                    authorization,
                    xLocale: request.headers["x-locale"] || null,
                    xRequestedWith: request.headers["x-requested-with"] || null
                }
            });
            return;
        }

        if (request.method === "GET" && requestUrl.pathname === "/api/v1/protected-echo") {
            if (authorization !== `Bearer ${ACCESS_TOKEN}`) {
                sendJson(response, 401, {message: "Unauthorized"});
                return;
            }

            sendJson(response, 200, {
                ok: true,
                authorization
            });
            return;
        }

        if (request.method === "POST" && requestUrl.pathname === "/api/v1/json-echo") {
            sendJson(response, 200, {
                received: await readJsonBody(request),
                headers: {
                    xLocale: request.headers["x-locale"] || null
                }
            });
            return;
        }

        if (request.method === "POST" && requestUrl.pathname === "/api/v1/upload-avatar") {
            const buffer = await readRequestBuffer(request);
            const multipart = parseMultipartForm(buffer, request.headers["content-type"]);
            sendJson(response, 200, {
                ok: true,
                filesCount: multipart.files.length,
                fields: multipart.fields,
                files: multipart.files,
                authorization
            });
            return;
        }

        if (request.method === "GET" && requestUrl.pathname === "/api/v1/text-response") {
            sendText(response, 200, "plain-text-response");
            return;
        }

        if (request.method === "GET" && requestUrl.pathname === "/api/v1/error") {
            sendJson(response, 418, {
                message: "Synthetic raw error",
                code: "I_AM_A_TEAPOT"
            });
            return;
        }

        if (request.method === "GET" && /^\/api\/v1\/users\/\d+$/.test(requestUrl.pathname)) {
            if (authorization !== `Bearer ${ACCESS_TOKEN}`) {
                sendJson(response, 401, {message: "Unauthorized"});
                return;
            }

            const userId = Number(requestUrl.pathname.split("/").pop());
            sendJson(response, 200, {
                content: {
                    userId,
                    details: requestUrl.searchParams.get("details") || "basic"
                }
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
        swaggerUrl: `${baseUrl}/swagger.json`
    };
}

async function run() {
    const fixture = await startFixtureServer();
    const fakeServer = new FakeMcpServer();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "outvento-swagger-smoke-"));
    const uploadFilePath = path.join(tempDir, "avatar.txt");
    await writeFile(uploadFilePath, "avatar-from-disk", "utf8");

    try {
        const swaggerService = createSwaggerService({swaggerUrl: fixture.swaggerUrl});
        const registration = await registerSwaggerTools(fakeServer, {
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
                autoLogin: true
            },
            apiConfig: {
                requestTimeoutMs: 15000,
                retryOnUnauthorized: true
            }
        });

        assert.ok(registration.registeredToolNames.includes("call_api_raw"));
        assert.ok(registration.registeredToolNames.includes("inspect_swagger_endpoint"));

        const smokeResults = {};

        smokeResults.auth_status_before = await fakeServer.call("auth_status");
        assert.equal(smokeResults.auth_status_before.ok, true);
        assert.equal(smokeResults.auth_status_before.auth.authenticated, false);

        smokeResults.auth_login = await fakeServer.call("auth_login", {
            login: VALID_LOGIN,
            password: VALID_PASSWORD
        });
        assert.equal(smokeResults.auth_login.ok, true);

        smokeResults.call_api_raw_get = await fakeServer.call("call_api_raw", {
            method: "get",
            baseUrl: fixture.baseUrl,
            path: "/api/v1/raw-echo/{id}",
            pathParams: {id: 123},
            query: {
                page: 2,
                tag: ["alpha", "beta"]
            },
            headers: {
                Authorization: "Bearer manual-token",
                "X-Locale": "uk",
                "X-Requested-With": "XMLHttpRequest"
            },
            includeRawBody: true
        });
        assert.equal(smokeResults.call_api_raw_get.ok, true);
        assert.equal(smokeResults.call_api_raw_get.response.status, 200);
        assert.equal(smokeResults.call_api_raw_get.response.body.path, "/api/v1/raw-echo/123");
        assert.deepEqual(smokeResults.call_api_raw_get.response.body.queryAll.tag, ["alpha", "beta"]);
        assert.equal(smokeResults.call_api_raw_get.response.body.headers.authorization, "Bearer manual-token");
        assert.equal(smokeResults.call_api_raw_get.response.body.headers.xLocale, "uk");

        smokeResults.call_api_raw_use_existing_auth = await fakeServer.call("call_api_raw", {
            method: "get",
            path: "/api/v1/protected-echo",
            useExistingMcpAuth: true
        });
        assert.equal(smokeResults.call_api_raw_use_existing_auth.ok, true);
        assert.equal(smokeResults.call_api_raw_use_existing_auth.response.body.authorization, `Bearer ${ACCESS_TOKEN}`);

        smokeResults.call_api_raw_post_json = await fakeServer.call("call_api_raw", {
            method: "post",
            baseUrl: fixture.baseUrl,
            path: "/api/v1/json-echo",
            headers: {
                "X-Locale": "en"
            },
            jsonBody: {
                profile: {
                    name: "Ada Lovelace"
                }
            }
        });
        assert.equal(smokeResults.call_api_raw_post_json.ok, true);
        assert.equal(smokeResults.call_api_raw_post_json.response.body.received.profile.name, "Ada Lovelace");
        assert.equal(smokeResults.call_api_raw_post_json.response.body.headers.xLocale, "en");

        smokeResults.call_api_raw_post_multipart = await fakeServer.call("call_api_raw", {
            method: "post",
            baseUrl: fixture.baseUrl,
            path: "/api/v1/upload-avatar",
            headers: {
                Authorization: "Bearer upload-token"
            },
            multipart: {
                fields: [
                    {
                        name: "avatar",
                        filePath: uploadFilePath,
                        contentType: "text/plain"
                    },
                    {
                        name: "folder",
                        value: "profile"
                    }
                ]
            }
        });
        assert.equal(smokeResults.call_api_raw_post_multipart.ok, true);
        assert.equal(smokeResults.call_api_raw_post_multipart.response.body.filesCount, 1);
        assert.equal(smokeResults.call_api_raw_post_multipart.response.body.fields.folder, "profile");
        assert.equal(smokeResults.call_api_raw_post_multipart.response.body.files[0].fileName, "avatar.txt");
        assert.equal(smokeResults.call_api_raw_post_multipart.response.body.authorization, "Bearer upload-token");

        smokeResults.call_api_raw_parse_debug = await fakeServer.call("call_api_raw", {
            method: "get",
            baseUrl: fixture.baseUrl,
            path: "/api/v1/text-response",
            expectedResponseType: "json",
            includeRawBody: true
        });
        assert.equal(smokeResults.call_api_raw_parse_debug.ok, true);
        assert.equal(smokeResults.call_api_raw_parse_debug.response.parseError !== null, true);
        assert.equal(smokeResults.call_api_raw_parse_debug.response.rawBody, "plain-text-response");
        assert.equal(smokeResults.call_api_raw_parse_debug.response.detectedResponseType, "json");

        smokeResults.call_api_raw_error = await fakeServer.call("call_api_raw", {
            method: "get",
            baseUrl: fixture.baseUrl,
            path: "/api/v1/error",
            includeRawBody: true
        });
        assert.equal(smokeResults.call_api_raw_error.ok, false);
        assert.equal(smokeResults.call_api_raw_error.error.kind, "http_error");
        assert.equal(smokeResults.call_api_raw_error.error.status, 418);
        assert.equal(smokeResults.call_api_raw_error.response.body.message, "Synthetic raw error");

        smokeResults.get_endpoint = await fakeServer.call("get_endpoint", {
            path: "/api/v1/users/{userId}",
            method: "get"
        });
        assert.equal(smokeResults.get_endpoint.endpoint.operationId, "getUserProfile");
        assert.ok(smokeResults.get_endpoint.endpoint.requiredParams.some((parameter) => parameter.name === "userId"));
        assert.ok(smokeResults.get_endpoint.endpoint.requiredParams.some((parameter) => parameter.name === "details"));

        smokeResults.inspect_swagger_endpoint = await fakeServer.call("inspect_swagger_endpoint", {
            operationId: "saveUserAvatar",
            includeSchemaDefinitions: true,
            forceRefresh: true
        });
        assert.equal(smokeResults.inspect_swagger_endpoint.endpoint.operationId, "saveUserAvatar");
        assert.ok(smokeResults.inspect_swagger_endpoint.endpoint.requestBody.contentTypes.includes("multipart/form-data"));
        assert.ok(smokeResults.inspect_swagger_endpoint.schemaNames.includes("AvatarUploadRequest"));
        assert.ok(smokeResults.inspect_swagger_endpoint.schemaDefinitions.AvatarUploadRequest);

        smokeResults.call_api_by_swagger = await fakeServer.call("call_api_by_swagger", {
            operationId: "getUserProfile",
            pathParams: {
                userId: 42
            },
            query: {
                details: "full"
            }
        });
        assert.equal(smokeResults.call_api_by_swagger.ok, true);
        assert.equal(smokeResults.call_api_by_swagger.data.content.userId, 42);
        assert.equal(smokeResults.call_api_by_swagger.data.content.details, "full");

        console.log(JSON.stringify({ok: true, smokeResults}, null, 2));
    } finally {
        await rm(tempDir, {recursive: true, force: true}).catch(() => undefined);
        await new Promise((resolve) => fixture.server.close(resolve));
    }
}

run().catch((error) => {
    console.error(JSON.stringify({ok: false, error: error.message, stack: error.stack}, null, 2));
    process.exitCode = 1;
});

