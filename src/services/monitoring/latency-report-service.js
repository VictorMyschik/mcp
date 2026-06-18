import {spawn} from "node:child_process";
import {existsSync} from "node:fs";
import os from "node:os";
import path from "node:path";

import {getLatencyReportScriptPath} from "./resolve-outvento-root.js";

function expandHome(filePath) {
    if (!filePath.startsWith("~/")) {
        return filePath;
    }

    return path.join(os.homedir(), filePath.slice(2));
}

export function createLatencyReportService({monitoringConfig}) {
    const scriptPath = monitoringConfig.outventoRoot
        ? getLatencyReportScriptPath(monitoringConfig.outventoRoot)
        : null;

    return {
        isReady() {
            return Boolean(
                monitoringConfig.enabled
                && scriptPath
                && existsSync(scriptPath)
                && existsSync(monitoringConfig.sshKeyPath)
            );
        },

        getDiagnostics() {
            return {
                enabled: monitoringConfig.enabled,
                outventoRoot: monitoringConfig.outventoRoot,
                scriptPath,
                scriptExists: Boolean(scriptPath && existsSync(scriptPath)),
                sshHost: monitoringConfig.sshHost,
                sshUser: monitoringConfig.sshUser,
                sshKeyPath: monitoringConfig.sshKeyPath,
                sshKeyExists: existsSync(monitoringConfig.sshKeyPath)
            };
        },

        async runReport({
            environment = "all",
            since = "1h",
            filter = "human",
            topN = 15
        } = {}) {
            if (!this.isReady()) {
                throw new Error("Monitoring latency report is not configured (missing OUTVENTO_ROOT script or SSH key).");
            }

            const env = {
                ...process.env,
                ENV: environment,
                SINCE: since,
                FILTER: filter,
                TOP_N: String(topN),
                FORMAT: "json",
                SYNC_SSH_HOST: monitoringConfig.sshHost,
                SYNC_SSH_USER: monitoringConfig.sshUser,
                SYNC_SSH_KEY: monitoringConfig.sshKeyPath
            };

            const stdout = await runScript(scriptPath, env);
            const trimmed = stdout.trim();

            try {
                return JSON.parse(trimmed);
            } catch (error) {
                throw new Error(`Latency report returned invalid JSON: ${trimmed.slice(0, 500)}`);
            }
        }
    };
}

function runScript(scriptPath, env) {
    return new Promise((resolve, reject) => {
        const child = spawn("bash", [scriptPath], {
            env,
            stdio: ["ignore", "pipe", "pipe"]
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });

        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });

        child.on("error", reject);

        child.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(stderr.trim() || `latency_report.sh exited with code ${code}`));
                return;
            }

            if (stderr.trim()) {
                reject(new Error(stderr.trim()));
                return;
            }

            resolve(stdout);
        });
    });
}

export function resolveMonitoringPaths(env) {
    const sshKeyPath = expandHome(String(env.MONITORING_SSH_KEY || env.SYNC_SSH_KEY || "~/.ssh/outvento_server").trim());

    return {
        sshHost: String(env.MONITORING_SSH_HOST || env.SYNC_SSH_HOST || "167.86.76.119").trim(),
        sshUser: String(env.MONITORING_SSH_USER || env.SYNC_SSH_USER || "outvento").trim(),
        sshKeyPath
    };
}
