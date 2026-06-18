import {z} from "zod";

import {getErrorMessage} from "../utils/errors.js";
import {asToolResult} from "./tool-result.js";

const latencyReportInputSchema = {
    environment: z.enum(["dev", "prod", "all"]).optional().describe("Target environment (default: all)."),
    since: z.string().optional().describe("Log window passed to docker logs --since (default: 1h). Examples: 30m, 2h, 24h."),
    filter: z.enum(["human", "api", "all"]).optional().describe("Traffic filter: human excludes bots/scanners (default), api keeps /api/v1/ only, all keeps everything."),
    topN: z.number().int().min(1).max(50).optional().describe("Number of slowest requests to include (default: 15).")
};

export function registerMonitoringTools(server, {latencyReportService}) {
    server.registerTool(
        "monitoring_latency_report",
        {
            description: "Build nginx latency report from remote access logs (same rt= metric as Grafana Outvento Response Time). Use when asked to review latency/performance report.",
            inputSchema: latencyReportInputSchema
        },
        async (input) => {
            try {
                const report = await latencyReportService.runReport({
                    environment: input.environment || "all",
                    since: input.since || "1h",
                    filter: input.filter || "human",
                    topN: input.topN ?? 15
                });

                return asToolResult(report);
            } catch (error) {
                return asToolResult({
                    status: "error",
                    error: getErrorMessage(error),
                    diagnostics: latencyReportService.getDiagnostics()
                });
            }
        }
    );

    return {
        registeredToolNames: ["monitoring_latency_report"]
    };
}
