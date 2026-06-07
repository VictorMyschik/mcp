import assert from "node:assert/strict";
import test from "node:test";

import {getConfigFromEnv} from "../src/config/env.js";
import {extractHtmlSnippet} from "../src/services/vitour/vitour-html-snippet.js";
import {normalizeVitourPageInput} from "../src/services/vitour/vitour-pages.js";
import {resolveVitourPageFile, resolveVitourRelativePath, resolveVitourRoot} from "../src/services/vitour/vitour-paths.js";
import {registerVitourTools} from "../src/tools/register-vitour-tools.js";

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

test("resolveVitourRoot finds the workspace vitour template", () => {
    const root = resolveVitourRoot({
        VITOUR_ROOT: "/home/allximik/ide/vitour"
    });

    assert.equal(root, "/home/allximik/ide/vitour");
});

test("getConfigFromEnv exposes vitour settings when root exists", () => {
    const config = getConfigFromEnv({
        VITOUR_ROOT: "/home/allximik/ide/vitour",
        VITOUR_BASE_URL: "http://127.0.0.1:8765"
    });

    assert.equal(config.vitour.root, "/home/allximik/ide/vitour");
    assert.equal(config.vitour.baseUrl, "http://127.0.0.1:8765");
    assert.equal(config.tools.vitour.enabled, true);
});

test("normalizeVitourPageInput maps slugs and file names", () => {
    assert.equal(normalizeVitourPageInput("blog"), "blog.html");
    assert.equal(normalizeVitourPageInput("blog-details"), "blog-details.html");
    assert.equal(normalizeVitourPageInput("blog.html"), "blog.html");
});

test("resolveVitourRelativePath blocks path traversal", () => {
    assert.throws(
        () => resolveVitourRelativePath("/home/allximik/ide/vitour", "../outside.html"),
        /inside VITOUR_ROOT/
    );
});

test("extractHtmlSnippet finds class selectors in HTML", () => {
    const html = '<main><section class="blog-card"><h2>Title</h2></section></main>';
    const result = extractHtmlSnippet(html, {selector: ".blog-card", contextChars: 80});

    assert.equal(result.found, true);
    assert.match(result.snippet, /blog-card/);
});

test("vitour_list_pages and vitour_read_snippet work without browser", async () => {
    const root = resolveVitourRoot({VITOUR_ROOT: "/home/allximik/ide/vitour"});
    if (!root) {
        return;
    }

    const server = new FakeMcpServer();
    registerVitourTools(server, {
        vitourConfig: {
            root,
            host: "127.0.0.1",
            port: 8765,
            baseUrl: "http://127.0.0.1:8765"
        },
        browserWorkflows: null
    });

    const pages = await server.call("vitour_list_pages");
    assert.equal(pages.ok, true);
    assert.ok(pages.pages.some((entry) => entry.file === "blog.html"));

    const snippet = await server.call("vitour_read_snippet", {page: "blog", selector: "html"});
    assert.equal(snippet.ok, true);
    assert.equal(snippet.file, "blog.html");
    assert.match(snippet.snippet, /<html/i);
});

test("resolveVitourPageFile resolves blog slug to an existing file", () => {
    const root = "/home/allximik/ide/vitour";
    const pageRef = resolveVitourPageFile(root, "blog");

    assert.equal(pageRef.file, "blog.html");
    assert.equal(pageRef.pathname, "/blog.html");
});
