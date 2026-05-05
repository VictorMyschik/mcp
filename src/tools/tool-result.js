export function asToolResult(payload) {
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(payload, null, 2)
            }
        ],
        structuredContent: payload
    };
}

