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

## Agent runbook (autonomous mode)

Use this policy for any AI agent that consumes this MCP server.

### 1) Mandatory first-step diagnostics

Always run, in this order:
1. `tool_status`
2. `health`
3. `auth_status`

Do not ask the user what to do before these checks are complete.

### 2) Decision policy

- `tool_status=ok` and `health=ok`:
  - server is healthy
  - if request requires auth and `auth_status` is not authenticated, run `auth_login` (when credentials are available) or ask only for missing credentials
- `tool_status=ok` and `health!=ok`:
  - perform a soft recovery:
    1) `auth_logout`
    2) re-run `auth_status`
    3) re-run `health`
  - if still unhealthy, escalate to hard restart instructions
- `tool_status!=ok`:
  - skip soft recovery and escalate directly to hard restart instructions

### 3) Soft recovery definition

Soft recovery means MCP session reset only (token/session cleanup), not process restart:
- `auth_logout`
- re-check `tool_status`, `health`, `auth_status`

### 4) Hard restart policy

If hard restart is required, the agent must explicitly state that host-level restart is outside MCP tool scope.
Then provide concrete commands by runtime option:

```bash
# Docker Compose
docker-compose restart <mcp_service_name>
docker-compose restart

# systemd
sudo systemctl restart mcp
```

If runtime is unknown, ask one short question: `docker, systemd, or other?`

### 5) Response format requirements

Every operational response should include:
1. Current state (`tool_status`, `health`, `auth_status`)
2. Action taken automatically
3. Next automatic step (or one minimal blocking question)

Avoid open-ended prompts like "How do we proceed?" when a deterministic next step exists.

