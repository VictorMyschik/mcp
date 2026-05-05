# mcp

MCP server that combines PostgreSQL tools and Swagger/OpenAPI tools.

Swagger group also includes `call_api_by_swagger`, which executes real HTTP requests using path/method from the loaded spec.

## `call_api_by_swagger` examples

Use these as ready payloads for MCP tool calls.

### GET with `pathParams` and `query`

```json
{
  "path": "/users/{id}",
  "method": "get",
  "pathParams": {
	"id": 42
  },
  "query": {
	"include": "roles",
	"verbose": true
  }
}
```

### POST with JSON `body` and custom header

```json
{
  "path": "/orders",
  "method": "post",
  "headers": {
	"x-request-id": "demo-req-001"
  },
  "body": {
	"customerId": 123,
	"items": [
	  {
		"sku": "A-100",
		"qty": 2
	  }
	]
  }
}
```

### Override `baseUrl`

```json
{
  "path": "/health",
  "method": "get",
  "baseUrl": "https://staging.api.example.com"
}
```

Notes:
- `baseUrl` priority: explicit `baseUrl` -> first Swagger `servers[0].url` -> origin of `SWAGGER_URL`.
- If Swagger marks a query/path param as required, tool returns an error when it is missing.
- If Swagger marks `requestBody` as required, pass `body`.
- If `body` is provided and no `content-type` header is set, tool uses `application/json`.

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

