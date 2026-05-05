# mcp

MCP server combining PostgreSQL tools and Swagger/OpenAPI tools.

The Swagger side is designed as an execution layer for another agent:
- auth is managed inside MCP memory
- operation tools are generated from Swagger `operationId`
- consumers do not pass `Authorization` headers, API paths, or HTTP methods

## Swagger tool behavior

Registered core Swagger tools:
- `auth_login` - stores token in MCP session memory
- `auth_logout` - clears stored token
- `auth_status` - shows auth session state
- `call_api_by_swagger` - low-level operationId caller with internal auth header injection
- `get_profile_page` - high-level profile page wrapper
- `get_translations` - high-level translations wrapper
- `update_profile` - high-level profile update wrapper
- `list_api_endpoints`
- `get_endpoint`
- `get_schema`
- `find_endpoint_by_keyword`

Additionally, MCP generates one tool per Swagger operation:
- tool name pattern: `api_<operation_id_normalized>`
- fallback when `operationId` is missing: `api_<method>_<path>`
- input shape for generated tools:
  - `pathParams` (optional)
  - `query` (optional)
  - `body` (optional)

Example generated tools:
- `api_get_profile`
- `api_update_profile`
- `api_get_translations`

Wrapper mapping order is deterministic:
- fixed table `tool_name -> operationId`
- startup validation fails fast if mapped `operationId` is absent in Swagger

## Authentication flow

Preferred usage:
1. Call `auth_login` once (or configure env credentials for auto-login).
2. Call wrapper tools or `api_*` tools mapped by Swagger `operationId`.

MCP handles:
- token storage in process memory
- automatic `Authorization` header injection
- clear unauthorized errors: `Unauthorized: call auth_login first`

## Environment

- Create `.env` in repository root.
- SQL tools require: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.
- Swagger tools require: `SWAGGER_URL`.

Auth/API controls:
- `AUTH_LOGIN_PATH` (default: `/api/v1/login`)
- `AUTH_LOGIN_METHOD` (default: `post`)
- `AUTH_USERNAME_FIELD` (default: `username`)
- `AUTH_PASSWORD_FIELD` (default: `password`)
- `AUTH_TOKEN_FIELD_PATH` (default: `content.accessToken`)
- `AUTH_TOKEN_TYPE_FIELD_PATH` (default: `content.tokenType`)
- `AUTH_DEFAULT_TOKEN_TYPE` (default: `Bearer`)
- `AUTH_TOKEN` (optional pre-seeded static token)
- `AUTH_USERNAME` / `AUTH_PASSWORD` (optional for auto-login)
- `AUTH_AUTO_LOGIN` (default: `true`)
- `API_REQUEST_TIMEOUT_MS` (default: `15000`)
- `API_RETRY_ON_UNAUTHORIZED` (default: `true`)

If required variables are missing, corresponding tool groups are not registered.
`tool_status` is always available.

## Structure

- `index.js` - bootstrap and wiring.
- `src/config/env.js` - environment config parsing.
- `src/infrastructure/db/client.js` - PostgreSQL client factory.
- `src/services/auth/auth-session.js` - auth session and token management.
- `src/services/swagger/swagger-cache.js` - Swagger loading and cache.
- `src/tools/register-sql-tools.js` - SQL MCP tools.
- `src/tools/register-swagger-tools.js` - auth and generated Swagger operation tools.
- `src/tools/register-health-tool.js` - combined health check tool.
- `src/tools/register-status-tool.js` - tool availability diagnostics.

## Run

```bash
npm install
npm start
```

## Quick check

```bash
npm run check
```
