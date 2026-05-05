import {asToolResult} from "./tool-result.js";

export function registerStatusTool(server, {toolAvailability, registeredToolNamesByGroup, alwaysRegisteredToolNames = []}) {
    server.registerTool(
        "tool_status",
        {
            description: "Return MCP tool registration status and environment diagnostics.",
            inputSchema: {}
        },
        async () => {
            const sortedGroupNames = Object.keys(toolAvailability).sort();
            const groups = Object.fromEntries(
                sortedGroupNames.map((groupName) => {
                    const state = toolAvailability[groupName];
                    return [
                        groupName,
                        {
                            enabled: state.enabled,
                            missingEnvVars: [...(state.missingEnvVars || [])].sort()
                        }
                    ];
                })
            );

            const tools = {
                tool_status: {
                    group: "core",
                    registered: true
                }
            };

            for (const toolName of [...alwaysRegisteredToolNames].sort()) {
                tools[toolName] = {
                    group: "core",
                    registered: true
                };
            }

            for (const groupName of Object.keys(registeredToolNamesByGroup).sort()) {
                const configuredTools = registeredToolNamesByGroup[groupName] || [];
                const groupEnabled = groups[groupName]?.enabled === true;
                for (const toolName of [...configuredTools].sort()) {
                    tools[toolName] = {
                        group: groupName,
                        registered: groupEnabled
                    };
                }
            }

            const sortedTools = Object.fromEntries(
                Object.entries(tools).sort(([left], [right]) => left.localeCompare(right))
            );

            const registeredCount = Object.values(sortedTools).filter((state) => state.registered).length;
            const totalCount = Object.keys(sortedTools).length;

            return asToolResult({
                status: "ok",
                timestamp: new Date().toISOString(),
                registeredTools: `${registeredCount}/${totalCount}`,
                groups,
                tools: sortedTools
            });
        }
    );
}
