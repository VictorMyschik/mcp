# mcp

MCP server that combines PostgreSQL tools and Swagger/OpenAPI tools.

## Environment

- Create `.env` from defaults in repository root.
- SQL tools require: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.
- Swagger tools require: `SWAGGER_URL`.
- If required variables are missing, corresponding tools are not registered.
- `tool_status` is always available and returns compact diagnostics: group readiness and per-tool `registered: true/false`.

## Structure

- `index.js` - bootstrap and wiring only.
- `src/config/env.js` - environment config parsing.
- `src/infrastructure/db/client.js` - PostgreSQL client factory.
- `src/services/swagger/swagger-cache.js` - Swagger loading and cache.
- `src/tools/register-sql-tools.js` - SQL related MCP tools.
- `src/tools/register-swagger-tools.js` - Swagger related MCP tools.
- `src/tools/register-health-tool.js` - combined health check tool.
- `src/tools/register-status-tool.js` - tool availability and env diagnostics.
- `src/utils/errors.js` - shared error helpers.

## Run

```bash
npm install
npm start
```

## Quick check

```bash
npm run check
```

