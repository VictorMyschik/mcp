import * as z from "zod/v4";
import {readdir} from "node:fs/promises";
import {readFile} from "node:fs/promises";

import {buildVitourPageCatalog} from "../services/vitour/vitour-pages.js";
import {extractHtmlSnippet} from "../services/vitour/vitour-html-snippet.js";
import {resolveVitourPageFile, resolveVitourRelativePath} from "../services/vitour/vitour-paths.js";
import {ensureVitourStaticServer, getVitourStaticServerState} from "../services/vitour/vitour-static-server.js";
import {asToolResult} from "./tool-result.js";

const viewportInputSchema = z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive()
});

export function registerVitourTools(server, {vitourConfig, browserWorkflows = null, fetchImpl}) {
    const registeredToolNames = [
        "vitour_list_pages",
        "vitour_ensure_server",
        "vitour_read_snippet"
    ];

    if (!vitourConfig?.root) {
        return {registeredToolNames: []};
    }

    const root = vitourConfig.root;
    const host = vitourConfig.host;
    const port = vitourConfig.port;
    const baseUrl = vitourConfig.baseUrl;

    async function listPages() {
        const entries = await readdir(root, {withFileTypes: true});
        const pages = buildVitourPageCatalog(root, entries);
        return {
            ok: true,
            root,
            baseUrl,
            pageCount: pages.length,
            pages,
            staticServer: getVitourStaticServerState()
        };
    }

    server.registerTool(
        "vitour_list_pages",
        {
            description: "List top-level Vitour HTML pages with design-reference hints for Outvento frontend work.",
            inputSchema: {}
        },
        async () => asToolResult(await listPages())
    );

    server.registerTool(
        "vitour_ensure_server",
        {
            description: "Ensure the local Vitour static HTTP server is running (python3 -m http.server) and return baseUrl.",
            inputSchema: {}
        },
        async () => {
            try {
                const serverState = await ensureVitourStaticServer({
                    root,
                    host,
                    port,
                    baseUrl,
                    fetchImpl
                });
                return asToolResult({
                    ok: true,
                    root,
                    ...serverState,
                    staticServer: getVitourStaticServerState()
                });
            } catch (error) {
                return asToolResult({
                    ok: false,
                    root,
                    baseUrl,
                    error: error instanceof Error ? error.message : String(error),
                    staticServer: getVitourStaticServerState()
                });
            }
        }
    );

    server.registerTool(
        "vitour_read_snippet",
        {
            description: "Read an HTML/CSS snippet from a Vitour page file on disk (read-only, no browser required).",
            inputSchema: {
                page: z.string().min(1).optional(),
                file: z.string().min(1).optional(),
                relativePath: z.string().min(1).optional(),
                selector: z.string().min(1).optional(),
                contextChars: z.number().int().positive().max(20000).optional(),
                maxChars: z.number().int().positive().max(50000).optional()
            }
        },
        async ({page, file, relativePath, selector, contextChars, maxChars}) => {
            try {
                let absolutePath;
                let resolvedFile;
                let pathname;

                if (relativePath) {
                    absolutePath = resolveVitourRelativePath(root, relativePath);
                    resolvedFile = relativePath.replace(/^\/+/, "");
                    pathname = resolvedFile.startsWith("/") ? resolvedFile : `/${resolvedFile}`;
                } else {
                    const pageRef = resolveVitourPageFile(root, page || file);
                    absolutePath = pageRef.absolutePath;
                    resolvedFile = pageRef.file;
                    pathname = pageRef.pathname;
                }

                const content = await readFile(absolutePath, "utf8");
                const snippetResult = extractHtmlSnippet(content, {
                    selector,
                    contextChars,
                    maxChars
                });

                return asToolResult({
                    ok: true,
                    root,
                    file: resolvedFile,
                    pathname,
                    absolutePath,
                    lineCount: content.split(/\r?\n/).length,
                    selector: selector || null,
                    ...snippetResult
                });
            } catch (error) {
                return asToolResult({
                    ok: false,
                    root,
                    error: error instanceof Error ? error.message : String(error)
                });
            }
        }
    );

    if (browserWorkflows?.runPageOpenWorkflow) {
        registeredToolNames.push("vitour_open_page");

        server.registerTool(
            "vitour_open_page",
            {
                description: "Start Vitour static server, open a Playwright session on a Vitour page, and keep the session open for follow-up browser_* tools.",
                inputSchema: {
                    page: z.string().min(1),
                    device: z.string().optional(),
                    headless: z.boolean().optional(),
                    viewport: viewportInputSchema.optional(),
                    targetSelector: z.string().min(1).optional(),
                    waitForSelector: z.boolean().optional()
                }
            },
            async ({page, device, headless, viewport, targetSelector, waitForSelector}) => {
                await ensureVitourStaticServer({root, host, port, baseUrl, fetchImpl});
                const pageRef = resolveVitourPageFile(root, page);
                const catalog = await listPages();
                const catalogEntry = catalog.pages.find((entry) => entry.file === pageRef.file) || null;

                return browserWorkflows.runPageOpenWorkflow({
                    baseUrl,
                    path: pageRef.pathname,
                    device,
                    headless,
                    viewport,
                    auth: {mode: "none"},
                    defaultTargetSelector: waitForSelector === false
                        ? null
                        : targetSelector || catalogEntry?.suggestedSelectors?.[0] || null,
                    targetSelector
                });
            }
        );
    }

    if (browserWorkflows?.runInspectWorkflow) {
        registeredToolNames.push("vitour_inspect_page");

        server.registerTool(
            "vitour_inspect_page",
            {
                description: "Inspect a Vitour page in the browser: screenshot, optional target styles, console/network diagnostics; session is closed after capture.",
                inputSchema: {
                    page: z.string().min(1),
                    device: z.string().optional(),
                    headless: z.boolean().optional(),
                    viewport: viewportInputSchema.optional(),
                    targetSelector: z.string().min(1).optional(),
                    captureStyles: z.boolean().optional(),
                    captureConsole: z.boolean().optional(),
                    captureNetworkErrors: z.boolean().optional(),
                    takeFullPageScreenshot: z.boolean().optional(),
                    takeElementScreenshot: z.boolean().optional(),
                    styleProperties: z.array(z.string().min(1)).optional()
                }
            },
            async ({
                page,
                device,
                headless,
                viewport,
                targetSelector,
                captureStyles,
                captureConsole,
                captureNetworkErrors,
                takeFullPageScreenshot,
                takeElementScreenshot,
                styleProperties
            }) => {
                await ensureVitourStaticServer({root, host, port, baseUrl, fetchImpl});
                const pageRef = resolveVitourPageFile(root, page);
                const catalog = await listPages();
                const catalogEntry = catalog.pages.find((entry) => entry.file === pageRef.file) || null;
                const resolvedTargetSelector = targetSelector || catalogEntry?.suggestedSelectors?.[0] || null;
                const pageUrl = new URL(pageRef.pathname, baseUrl).toString();

                return browserWorkflows.runInspectWorkflow({
                    baseUrl,
                    url: pageUrl,
                    device,
                    headless,
                    viewport,
                    auth: {mode: "none"},
                    targetSelector: resolvedTargetSelector,
                    captureStyles: captureStyles ?? Boolean(resolvedTargetSelector),
                    captureConsole: captureConsole ?? true,
                    captureNetworkErrors: captureNetworkErrors ?? true,
                    takeFullPageScreenshot: takeFullPageScreenshot ?? true,
                    takeElementScreenshot: takeElementScreenshot ?? Boolean(resolvedTargetSelector),
                    styleProperties
                });
            }
        );
    }

    return {registeredToolNames};
}
