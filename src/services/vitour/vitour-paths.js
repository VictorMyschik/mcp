import path from "node:path";
import {existsSync} from "node:fs";

import {normalizeVitourPageInput} from "./vitour-pages.js";

export function resolveVitourRoot(env, {cwd = process.cwd()} = {}) {
    const explicit = String(env.VITOUR_ROOT || "").trim();
    if (explicit) {
        return path.resolve(explicit);
    }

    const candidates = [
        path.resolve(cwd, "../vitour"),
        path.resolve(cwd, "vitour"),
        "/home/allximik/ide/vitour"
    ];

    for (const candidate of candidates) {
        if (existsSync(candidate) && existsSync(path.join(candidate, "index.html"))) {
            return candidate;
        }
    }

    return null;
}

export function parseVitourBaseUrl(baseUrl) {
    const parsed = new URL(baseUrl);
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    return {
        baseUrl: parsed.origin,
        host: parsed.hostname,
        port
    };
}

/**
 * @param {string} root
 * @param {string} pageOrFile
 */
export function resolveVitourPageFile(root, pageOrFile) {
    const fileName = normalizeVitourPageInput(pageOrFile);
    if (!fileName || !fileName.endsWith(".html")) {
        throw new Error(`Invalid Vitour page '${pageOrFile}'. Use a slug (blog) or *.html file name.`);
    }

    const absolutePath = resolveVitourRelativePath(root, fileName);
    if (!existsSync(absolutePath)) {
        throw new Error(`Vitour page not found: ${fileName} (expected at ${absolutePath}).`);
    }

    return {
        file: fileName,
        absolutePath,
        pathname: `/${fileName}`
    };
}

/**
 * @param {string} root
 * @param {string} relativePath
 */
export function resolveVitourRelativePath(root, relativePath) {
    const resolvedRoot = path.resolve(root);
    const normalizedRelative = String(relativePath || "")
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\/+/, "");

    if (!normalizedRelative || normalizedRelative.includes("..")) {
        throw new Error("Vitour path must stay inside VITOUR_ROOT.");
    }

    const absolutePath = path.resolve(resolvedRoot, normalizedRelative);
    const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;

    if (absolutePath !== resolvedRoot && !absolutePath.startsWith(rootWithSep)) {
        throw new Error("Vitour path escapes VITOUR_ROOT.");
    }

    return absolutePath;
}
