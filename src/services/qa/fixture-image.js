import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";

// Minimal valid 1x1 JPEG payload reused for QA uploads.
const MINIMAL_JPEG_BASE64 = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCfAAH/2Q==";

export function resolveQaArtifactsDir(browserConfig = {}) {
    const configuredDir = String(browserConfig.artifactsDir || "artifacts/browser").trim();
    return path.resolve(path.dirname(configuredDir), "qa");
}

export async function prepareFixtureImage({
    artifactsDir,
    fileName = "fixture.jpg",
    variant = "default"
} = {}) {
    const targetDir = path.resolve(artifactsDir);
    await mkdir(targetDir, {recursive: true});

    const safeName = String(fileName || "fixture.jpg")
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/^[._-]+/, "") || "fixture.jpg";

    const extension = path.extname(safeName).toLowerCase();
    const resolvedName = extension ? safeName : `${safeName}.jpg`;
    const absolutePath = path.join(targetDir, resolvedName);
    const buffer = Buffer.from(MINIMAL_JPEG_BASE64, "base64");

    await writeFile(absolutePath, buffer);

    return {
        path: absolutePath,
        name: resolvedName,
        mimeType: "image/jpeg",
        size: buffer.length,
        variant
    };
}
