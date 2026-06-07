import {spawn} from "node:child_process";
import fetch from "node-fetch";

/** @type {import("node:child_process").ChildProcess | null} */
let managedProcess = null;

async function isReachable(baseUrl, {fetchImpl = fetch, timeoutMs = 1500} = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetchImpl(new URL("/", baseUrl).toString(), {
            method: "GET",
            signal: controller.signal
        });
        return response.ok || response.status < 500;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

async function waitForReachable(baseUrl, {fetchImpl = fetch, timeoutMs = 8000, intervalMs = 200} = {}) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        if (await isReachable(baseUrl, {fetchImpl, timeoutMs: Math.min(1500, timeoutMs)})) {
            return true;
        }

        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    return false;
}

function isManagedProcessAlive() {
    return Boolean(managedProcess && managedProcess.exitCode === null && !managedProcess.killed);
}

/**
 * @param {{ root: string, host: string, port: number, baseUrl: string, fetchImpl?: typeof fetch }} options
 */
export async function ensureVitourStaticServer({root, host, port, baseUrl, fetchImpl = fetch}) {
    if (await isReachable(baseUrl, {fetchImpl})) {
        return {
            ok: true,
            baseUrl,
            started: false,
            pid: isManagedProcessAlive() ? managedProcess.pid : null,
            message: "Vitour static server already reachable."
        };
    }

    if (isManagedProcessAlive()) {
        const ready = await waitForReachable(baseUrl, {fetchImpl});
        if (ready) {
            return {
                ok: true,
                baseUrl,
                started: false,
                pid: managedProcess.pid,
                message: "Reused in-process Vitour static server."
            };
        }
    }

    const processRef = spawn(
        "python3",
        ["-m", "http.server", String(port), "--bind", host],
        {
            cwd: root,
            stdio: "ignore",
            detached: false
        }
    );
    managedProcess = processRef;

    processRef.on("exit", () => {
        if (managedProcess === processRef) {
            managedProcess = null;
        }
    });

    const ready = await waitForReachable(baseUrl, {fetchImpl});
    if (!ready) {
        if (isManagedProcessAlive()) {
            managedProcess.kill("SIGTERM");
            managedProcess = null;
        }

        throw new Error(
            `Failed to start Vitour static server at ${baseUrl}. Check VITOUR_STATIC_PORT (${port}) and python3 availability.`
        );
    }

    return {
        ok: true,
        baseUrl,
        started: true,
        pid: processRef.pid,
        message: `Started python3 http.server in ${root}.`
    };
}

export function getVitourStaticServerState() {
    return {
        pid: isManagedProcessAlive() ? managedProcess.pid : null,
        running: isManagedProcessAlive()
    };
}
