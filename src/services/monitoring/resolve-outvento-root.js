import {existsSync} from "node:fs";
import path from "node:path";

const LATENCY_SCRIPT = path.join("scripts", "latency_report.sh");

export function resolveOutventoRoot(env, {cwd = process.cwd()} = {}) {
    const candidates = [];

    const configured = String(env.OUTVENTO_ROOT || "").trim();
    if (configured) {
        candidates.push(path.resolve(configured));
    }

    candidates.push(path.resolve(cwd, "..", "outvento"));
    candidates.push(path.resolve(cwd, "outvento"));

    const home = String(env.HOME || "").trim();
    if (home) {
        candidates.push(path.resolve(home, "ide", "outvento"));
    }

    for (const candidate of candidates) {
        if (existsSync(path.join(candidate, LATENCY_SCRIPT))) {
            return candidate;
        }
    }

    return null;
}

export function getLatencyReportScriptPath(outventoRoot) {
    return path.join(outventoRoot, LATENCY_SCRIPT);
}
