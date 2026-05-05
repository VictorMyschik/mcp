import * as z from "zod/v4";

import {asToolResult} from "./tool-result.js";

export function registerSqlTools(server, {dbClient}) {
    server.registerTool(
        "run_sql",
        {
            description: "Run a read-only SQL query and return rows.",
            inputSchema: {
                query: z.string().min(1)
            }
        },
        async ({query}) => {
            const result = await dbClient.query(query);
            return asToolResult({rows: result.rows});
        }
    );

    server.registerTool(
        "list_tables",
        {
            description: "List public schema table names.",
            inputSchema: {}
        },
        async () => {
            const result = await dbClient.query(`
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema = 'public'
                ORDER BY table_name
            `);
            return asToolResult({tables: result.rows});
        }
    );
}
