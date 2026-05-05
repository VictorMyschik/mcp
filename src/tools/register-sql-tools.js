export function registerSqlTools(server, {dbClient}) {
    server.tool(
        "run_sql",
        {
            query: "string"
        },
        async ({query}) => {
            const result = await dbClient.query(query);
            return result.rows;
        }
    );

    server.tool(
        "list_tables",
        {},
        async () => {
            const result = await dbClient.query(`
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema = 'public'
            `);
            return result.rows;
        }
    );
}

