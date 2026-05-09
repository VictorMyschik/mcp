import {createHash} from "node:crypto";

export function maskSecret(secret) {
    const normalized = String(secret || "");
    if (!normalized) {
        return "missing";
    }

    const hashPrefix = createHash("sha256")
        .update(normalized)
        .digest("hex")
        .slice(0, 8);

    return `len=${normalized.length} sha256=${hashPrefix}`;
}

