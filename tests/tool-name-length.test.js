import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import path from "node:path";

import {
    getGeneratedApiToolNameLimit,
    resolveGeneratedApiToolName
} from "../src/tools/register-swagger-tools.js";

const swaggerPath = path.resolve(import.meta.dirname, "../../outvento/storage/api-docs/api-docs.json");

test("generated api tool names fit Cursor MCP combined-name limit", () => {
    const swagger = JSON.parse(readFileSync(swaggerPath, "utf8"));
    const {serverName, combinedNameLimit} = getGeneratedApiToolNameLimit();
    const tooLong = [];

    for (const pathItem of Object.values(swagger.paths || {})) {
        for (const operation of Object.values(pathItem || {})) {
            const operationId = operation?.operationId;
            if (!operationId) {
                continue;
            }

            const toolName = resolveGeneratedApiToolName(operationId);
            const combinedLength = `${serverName} ${toolName}`.length;

            if (combinedLength > combinedNameLimit) {
                tooLong.push({operationId, toolName, combinedLength});
            }
        }
    }

    assert.deepEqual(
        tooLong,
        [],
        tooLong.map((entry) => `${entry.combinedLength} ${entry.toolName}`).join("\n")
    );
});

test("resolveGeneratedApiToolName shortens known long operation ids", () => {
    assert.equal(
        resolveGeneratedApiToolName("downloadConversationMessageAttachmentsZip"),
        "api_download_conv_msg_attach_zip"
    );
    assert.equal(
        resolveGeneratedApiToolName("importSelectedExternalCloudProviderMedia"),
        "api_import_selected_cloud_media"
    );
});
