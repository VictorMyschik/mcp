# mcp

MCP server combining PostgreSQL, Swagger/OpenAPI, and browser/frontend automation tools.

The Swagger side is designed as an execution layer for another agent:
- auth is managed inside MCP memory
- operation tools are generated from Swagger `operationId`
- consumers do not pass `Authorization` headers, API paths, or HTTP methods

The browser side is designed for frontend diagnostics and UI automation:
- stateful Playwright Chromium sessions
- screenshots and DOM/layout inspection
- frontend auth hydration via API login -> `localStorage`
- console and network diagnostics

## Browser tool behavior

Registered browser tools:
- `browser_open_session`
- `browser_close_session`
- `browser_navigate`
- `browser_auth_from_api_login`
- `browser_set_local_storage`
- `browser_seed_auth_state`
- `browser_open_profile_page`
- `browser_open_account_home`
- `browser_open_security_page`
- `browser_capture_profile_mobile`
- `browser_wait_for`
- `browser_click`
- `browser_fill`
- `browser_set_input_files`
- `browser_press`
- `browser_evaluate`
- `browser_get_text`
- `browser_get_attribute`
- `browser_screenshot`
- `browser_get_bounding_rect`
- `browser_get_computed_styles`
- `browser_assert_layout`
- `browser_save_storage_state`
- `browser_load_storage_state`
- `browser_get_console_logs`
- `browser_get_network_errors`
- `browser_inspect_page`

### Browser auth flow

Preferred frontend authentication flow:
1. Obtain API tokens using `auth_login` or `browser_auth_from_api_login`.
2. Write `{ accessToken, refreshToken, user: null }` into frontend `localStorage` via `browser_auth_from_api_login`, `browser_seed_auth_state`, or `browser_set_local_storage`.
3. Navigate directly to the target authenticated route.

This avoids brittle UI-login dependencies and keeps browser automation stable.

Supported auth modes in high-level browser tools:
- `apiLogin` - perform API login and hydrate frontend auth state into `localStorage`
- `useExistingMcpAuth` - reuse an already authenticated MCP auth session (for example after `auth_login`)
- `none` - skip auth hydration entirely

Auth hardening notes:
- `browser_auth_from_api_login` and `browser_inspect_page` now return structured auth failures:
  - `AUTH_API_LOGIN_FAILED`
  - `AUTH_REDIRECTED_TO_LOGIN`
  - `AUTH_SESSION_EXPIRED`
- when a valid shared MCP auth session exists, browser auth can fall back to `useExistingMcpAuth`
- `browser_set_local_storage` works on an explicit `origin` and can optionally `navigateToOrigin` and/or `reloadPage`
- `browser_seed_auth_state` is a convenience wrapper for common auth objects like `{ accessToken, refreshToken, user }`
- auth error payloads include:
  - `finalUrl`
  - `debugScreenshotPath`
  - `debugHtmlPath`

### Browser file upload flow

`browser_set_input_files` supports:
- one or many files
- local disk paths
- in-memory files from `text`
- in-memory files from `base64`
- regular and `multiple` file inputs

Recommended input file descriptor shapes:
- local file path as plain string
- `{ "path": "/abs/file.png" }`
- `{ "name": "avatar.txt", "mimeType": "text/plain", "text": "hello" }`
- `{ "name": "avatar.png", "mimeType": "image/png", "base64": "..." }`

### Browser diagnostics

Browser diagnostics are intentionally split to reduce noise:
- `consoleErrors` - actual console errors and page errors
- `consoleWarnings` - warnings that survived filtering
- `networkErrors` - failed requests and HTTP 4xx/5xx responses
- `ignoredNoiseCount` - filtered Vite/dev noise or harmless `net::ERR_ABORTED` requests

Backward-compatible fields are still returned where practical:
- `browser_get_console_logs` still returns `logs`
- `browser_get_network_errors` still returns `requests`

Interpretation guidelines:
- non-zero `ignoredNoiseCount` is expected in dev-mode frontends
- investigate `consoleErrors` first, then `networkErrors`
- `consoleWarnings` are useful for regressions, but not all warnings are fatal
- filtered noise should not hide real app errors: only known Vite/dev chatter and harmless aborted requests are ignored

Artifacts are written under `artifacts/browser/<sessionId>/...`.

## Swagger tool behavior

Registered core Swagger tools:
- `auth_login` - stores token in MCP session memory
- `auth_logout` - clears stored token
- `auth_status` - shows auth session state
- `call_api_raw` - universal raw HTTP caller with custom method/path/query/headers/body/multipart control
- `call_api_by_swagger` - low-level operationId caller with internal auth header injection
- `get_profile_page` - high-level profile page wrapper
- `get_translations` - high-level translations wrapper
- `update_profile` - high-level profile update wrapper
- `list_api_endpoints`
- `get_endpoint`
- `inspect_swagger_endpoint`
- `get_schema`
- `find_endpoint_by_keyword`

### `call_api_raw` contract

`call_api_raw` accepts:
- `method`
- either absolute `url`, or `baseUrl` + `path`
- `pathParams`
- `query`
- `headers`
- exactly one body mode:
  - `jsonBody`
  - `textBody`
  - `multipart.fields[]`
- `timeoutMs`
- `expectedResponseType`: `auto | json | text | base64`
- `includeRawBody`
- `useExistingMcpAuth`

`multipart.fields[]` item shape:
- `name` (required)
- one of:
  - `value`
  - `filePath`
  - `text`
  - `base64`
- optional `fileName`
- optional `contentType`

Response shape:
- `ok`
- `request` with resolved URL/method/body mode
- `response` with:
  - `status`
  - `statusText`
  - `headers`
  - `contentType`
  - `body`
  - `rawBody` (when requested or useful for debug)
  - `parseError` (when response could not be parsed as expected)
- structured `error` for `4xx/5xx`, timeouts, or network failures

### Swagger inspection helpers

`inspect_swagger_endpoint` accepts either:
- `operationId`, or
- `path` + `method`

Optional flags:
- `includeSchemaDefinitions`
- `forceRefresh`

It returns:
- resolved `operationId`
- combined required params
- request body content-types and schema refs
- response content-types and schema refs
- referenced schema names
- optional inline `schemaDefinitions`

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
- `AUTH_USERNAME_FIELD` (default: `login`)
- `AUTH_PASSWORD_FIELD` (default: `password`)
- `AUTH_TOKEN_FIELD_PATH` (default: `content.accessToken`)
- `AUTH_REFRESH_TOKEN_FIELD_PATH` (default: `content.refreshToken`)
- `AUTH_TOKEN_TYPE_FIELD_PATH` (default: `content.tokenType`)
- `AUTH_DEFAULT_TOKEN_TYPE` (default: `Bearer`)
- `AUTH_TOKEN` (optional pre-seeded static token)
- `AUTH_REFRESH_TOKEN` (optional pre-seeded static refresh token)
- `AUTH_USERNAME` / `AUTH_PASSWORD` (optional for auto-login)
- `AUTH_AUTO_LOGIN` (default: `true`)
- `API_REQUEST_TIMEOUT_MS` (default: `15000`)
- `API_RETRY_ON_UNAUTHORIZED` (default: `true`)

Browser controls:
- `BROWSER_TOOLS_ENABLED` (default: `true`)
- `BROWSER_HEADLESS_DEFAULT` (default: `true`)
- `BROWSER_SESSION_TTL_MS` (default: `600000`)
- `BROWSER_CLEANUP_INTERVAL_MS` (default: `60000`)
- `BROWSER_NAVIGATION_TIMEOUT_MS` (default: `30000`)
- `BROWSER_ACTION_TIMEOUT_MS` (default: `30000`)
- `BROWSER_MAX_CONSOLE_ENTRIES` (default: `200`)
- `BROWSER_MAX_NETWORK_ERRORS` (default: `200`)
- `FRONTEND_AUTH_STORAGE_KEY` (default: `auth`)
- `BROWSER_ARTIFACTS_DIR` (default: `artifacts/browser`)

If required variables are missing, corresponding tool groups are not registered.
`tool_status` is always available.

## Structure

- `index.js` - bootstrap and wiring.
- `src/config/env.js` - environment config parsing.
- `src/infrastructure/db/client.js` - PostgreSQL client factory.
- `src/services/auth/auth-session.js` - auth session and token management.
- `src/services/browser/session-manager.js` - stateful Playwright browser/context/page lifecycle.
- `src/services/browser/playwright-service.js` - navigate, wait, screenshot, DOM geometry, computed styles.
- `src/services/browser/artifact-service.js` - runtime screenshots, HTML dumps, JSON artifacts.
- `src/services/browser/auth-bridge.js` - API login to frontend `localStorage` auth hydration.
- `src/services/swagger/swagger-cache.js` - Swagger loading and cache.
- `src/services/swagger/http-executor.js` - shared raw HTTP execution, query/path resolution, multipart handling, and response parsing.
- `src/tools/register-browser-tools.js` - browser automation MCP tools.
- `src/tools/register-sql-tools.js` - SQL MCP tools.
- `src/tools/register-swagger-tools.js` - auth and generated Swagger operation tools.
- `src/tools/register-health-tool.js` - combined health check tool.
- `src/tools/register-status-tool.js` - tool availability diagnostics.
- `scripts/browser-smoke.js` - local end-to-end smoke scenario for browser tools.
- `scripts/swagger-smoke.js` - local smoke scenario for raw API and Swagger inspection tools.

## Run

```bash
npm install
npx playwright install chromium
npm start
```

## Quick check

```bash
npm run check
npm run smoke:swagger
npm run smoke:browser
```

## Example raw API tool calls

### GET with query params and custom headers

```json
{
  "method": "get",
  "baseUrl": "http://outvento.test",
  "path": "/api/v1/users/{userId}",
  "pathParams": {
    "userId": 42
  },
  "query": {
    "details": "full"
  },
  "headers": {
    "Authorization": "Bearer <token>",
    "X-Locale": "uk",
    "X-Requested-With": "XMLHttpRequest"
  },
  "includeRawBody": true
}
```

### POST JSON

```json
{
  "method": "post",
  "baseUrl": "http://outvento.test",
  "path": "/api/v1/profile",
  "headers": {
    "X-Locale": "en"
  },
  "jsonBody": {
    "firstName": "Ada",
    "lastName": "Lovelace"
  }
}
```

### POST multipart/form-data

```json
{
  "method": "post",
  "baseUrl": "http://outvento.test",
  "path": "/api/v1/user/avatar",
  "useExistingMcpAuth": true,
  "multipart": {
    "fields": [
      {
        "name": "avatar",
        "filePath": "/abs/path/avatar.png",
        "contentType": "image/png"
      },
      {
        "name": "folder",
        "value": "profile"
      }
    ]
  }
}
```

### Parse non-JSON responses for debug

```json
{
  "method": "get",
  "url": "http://outvento.test/api/v1/debug/raw-response",
  "expectedResponseType": "json",
  "includeRawBody": true
}
```

## Example browser tool calls

### Open a mobile session

```json
{
  "baseUrl": "http://outvento.test",
  "device": "iPhone 14 Pro Max",
  "headless": true
}
```

### Authenticate frontend via API login + localStorage

```json
{
  "sessionId": "browser-session-001",
  "baseUrl": "http://outvento.test",
  "login": "user@example.com",
  "password": "secret"
}
```

### Set arbitrary localStorage state on an origin

```json
{
  "sessionId": "browser-session-001",
  "origin": "http://outvento.test",
  "key": "settings",
  "value": {
    "locale": "uk",
    "theme": "dark"
  },
  "navigateToOrigin": true,
  "reloadPage": true
}
```

### Seed auth state directly

```json
{
  "sessionId": "browser-session-001",
  "origin": "http://outvento.test",
  "accessToken": "<access-token>",
  "refreshToken": "<refresh-token>",
  "user": {
    "id": 1,
    "email": "user@example.com"
  }
}
```

### Upload a single file from text

```json
{
  "sessionId": "browser-session-001",
  "selector": "input[type='file']",
  "files": [
    {
      "name": "avatar.txt",
      "mimeType": "text/plain",
      "text": "avatar-content"
    }
  ]
}
```

### Upload multiple files to `<input multiple>`

```json
{
  "sessionId": "browser-session-001",
  "selector": "input[type='file'][multiple]",
  "files": [
    "/abs/path/avatar.png",
    {
      "name": "meta.json",
      "mimeType": "application/json",
      "base64": "eyJoZWxsbyI6IndvcmxkIn0="
    }
  ]
}
```

## Example Swagger inspection calls

### Inspect by path + method

```json
{
  "path": "/api/v1/user/avatar",
  "method": "post",
  "includeSchemaDefinitions": true,
  "forceRefresh": true
}
```

### Inspect by operationId

```json
{
  "operationId": "saveUserAvatar",
  "includeSchemaDefinitions": true
}
```

### Open profile page with existing MCP auth

```json
{
  "baseUrl": "http://outvento.test",
  "auth": {
    "mode": "useExistingMcpAuth"
  }
}
```

### Open security page in a dedicated session

```json
{
  "baseUrl": "http://outvento.test",
  "device": "Desktop Chrome",
  "auth": {
    "mode": "apiLogin",
    "login": "user@example.com",
    "password": "secret"
  }
}
```

### Navigate and inspect

```json
{
  "sessionId": "browser-session-001",
  "url": "http://outvento.test/account/profile",
  "waitUntil": "networkidle"
}
```

### Interact with the page

```json
{
  "sessionId": "browser-session-001",
  "selector": ".profile-input",
  "value": "Ada Lovelace"
}
```

```json
{
  "sessionId": "browser-session-001",
  "selector": ".save-button"
}
```

```json
{
  "sessionId": "browser-session-001",
  "selector": ".shortcut-input",
  "key": "Enter"
}
```

```json
{
  "sessionId": "browser-session-001",
  "expression": "document.querySelector('.save-status').textContent"
}
```

```json
{
  "sessionId": "browser-session-001",
  "selector": ".save-status"
}
```

```json
{
  "sessionId": "browser-session-001",
  "selector": ".save-button",
  "name": "data-role"
}
```

```json
{
  "sessionId": "browser-session-001",
  "selector": ".profile-page",
  "assertions": {
    "topLessThanOrEqual": 80,
    "widthGreaterThanOrEqual": 390
  }
}
```

### Save and restore storage state

```json
{
  "sessionId": "browser-session-001",
  "fileName": "auth-state.json"
}
```

```json
{
  "sessionId": "browser-session-002",
  "path": "/.../artifacts/browser/browser-session-001/auth-state.json"
}
```

```json
{
  "sessionId": "browser-session-001",
  "selector": ".profile-page",
  "includeParents": true,
  "stopAt": "body"
}
```

### High-level inspection

```json
{
  "baseUrl": "http://outvento.test",
  "url": "http://outvento.test/account/profile",
  "device": "iPhone 14 Pro Max",
  "headless": true,
  "auth": {
    "mode": "apiLogin",
    "login": "user@example.com",
    "password": "secret"
  },
  "targetSelector": ".profile-page",
  "captureStyles": true,
  "captureConsole": true,
  "captureNetworkErrors": true,
  "takeFullPageScreenshot": true,
  "takeElementScreenshot": true
}
```

### Mobile profile capture

```json
{
  "baseUrl": "http://outvento.test",
  "headless": true,
  "auth": {
    "mode": "useExistingMcpAuth"
  }
}
```

## Example smoke flow

Short end-to-end browser smoke flow:
1. `auth_login` (optional but recommended when `useExistingMcpAuth` is used)
2. `browser_open_profile_page`
3. `browser_assert_layout`
4. `browser_get_console_logs`
5. `browser_get_network_errors`
6. `browser_open_security_page` or `browser_open_account_home`
7. `browser_capture_profile_mobile`
8. `browser_close_session`

## Browser smoke scenario

The included smoke harness starts a local mock frontend/API and validates this flow:

1. `browser_open_session`
2. `browser_auth_from_api_login`
3. `browser_open_profile_page`
4. `browser_open_account_home`
5. `browser_open_security_page`
6. `browser_capture_profile_mobile`
7. `browser_navigate`
8. `browser_wait_for`
9. `browser_fill`
11. `browser_set_input_files` (single file)
12. `browser_set_input_files` (multiple files)
13. `browser_click`
14. `browser_press`
15. `browser_evaluate`
16. `browser_get_text`
17. `browser_get_attribute`
18. `browser_assert_layout`
19. `browser_save_storage_state`
20. `browser_load_storage_state`
21. `browser_set_local_storage`
22. `browser_seed_auth_state`
23. `browser_screenshot` (full page)
24. `browser_screenshot` (element)
25. `browser_get_bounding_rect`
26. `browser_get_computed_styles`
27. `browser_get_console_logs`
28. `browser_get_network_errors`
29. `browser_inspect_page`
30. auth failure coverage for `AUTH_API_LOGIN_FAILED`, `AUTH_REDIRECTED_TO_LOGIN`, `AUTH_SESSION_EXPIRED`
31. `browser_close_session`

Artifacts are written under `artifacts/browser/<sessionId>/...` and are intentionally ignored by Git.

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

