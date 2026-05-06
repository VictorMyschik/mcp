import path from "node:path";
import {mkdir, readFile, writeFile} from "node:fs/promises";

function sanitizePathSegment(value, fallback = "artifact") {
    const normalized = String(value || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
    return normalized.replace(/^-+|-+$/g, "") || fallback;
}

function timestamp() {
    return new Date().toISOString().replace(/[:.]/g, "-");
}

export function createArtifactService({rootDir}) {
    async function ensureRootDir() {
        await mkdir(rootDir, {recursive: true});
        return rootDir;
    }

    async function ensureSessionDir(sessionId) {
        await ensureRootDir();
        const sessionDir = path.join(rootDir, sanitizePathSegment(sessionId, "session"));
        await mkdir(sessionDir, {recursive: true});
        return sessionDir;
    }

    async function resolveArtifactPath(sessionId, fileName, {addTimestamp = false} = {}) {
        const sessionDir = await ensureSessionDir(sessionId);
        const parsed = path.parse(String(fileName || "artifact"));
        const baseName = sanitizePathSegment(parsed.name, "artifact");
        const extension = parsed.ext || "";
        const finalName = addTimestamp
            ? `${baseName}-${timestamp()}${extension}`
            : `${baseName}${extension}`;

        return path.join(sessionDir, finalName);
    }

    async function writeJson(sessionId, fileName, payload, options = {}) {
        const filePath = await resolveArtifactPath(sessionId, fileName, options);
        await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
        return filePath;
    }

    async function writeHtml(sessionId, fileName, html, options = {}) {
        const filePath = await resolveArtifactPath(sessionId, fileName, options);
        await writeFile(filePath, String(html || ""), "utf8");
        return filePath;
    }

    async function readJson(filePath) {
        const content = await readFile(filePath, "utf8");
        return JSON.parse(content);
    }

    async function captureDebugArtifacts(session, {label = "debug-last-page"} = {}) {
        if (!session?.page || !session?.sessionId) {
            return null;
        }

        const debug = {
            screenshot: null,
            html: null
        };

        try {
            const screenshotPath = await resolveArtifactPath(session.sessionId, `${label}.png`, {addTimestamp: true});
            await session.page.screenshot({path: screenshotPath, fullPage: true});
            debug.screenshot = screenshotPath;
        } catch {
            debug.screenshot = null;
        }

        try {
            const html = await session.page.content();
            debug.html = await writeHtml(session.sessionId, `${label}.html`, html, {addTimestamp: true});
        } catch {
            debug.html = null;
        }

        if (!debug.screenshot && !debug.html) {
            return null;
        }

        return debug;
    }

    return {
        ensureRootDir,
        ensureSessionDir,
        resolveArtifactPath,
        writeJson,
        readJson,
        writeHtml,
        captureDebugArtifacts
    };
}

