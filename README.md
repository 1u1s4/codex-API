# codex-openai-api

Proyecto standalone para usar Codex OAuth y Gemini como librería TypeScript directa.

La superficie pública queda enfocada en cuatro piezas:

- `createCodexAuth`: login OAuth, persistencia local y refresh
- `createCodexClient`: acceso Codex por HTTP OAuth o por `codex` CLI local
- `createGeminiAuth`: login OAuth web para Gemini, persistencia local y refresh
- `createGeminiClient`: acceso Gemini por HTTP OAuth o por `gemini` CLI local

Los contratos operativos principales son `codex-auth.json`, `codex-sessions.json`, `gemini-auth.json` y `gemini-sessions.json`.

## Instalar

```bash
npm install codex-openai-api
```

También puedes usarla como dependencia local desde otro proyecto:

```bash
npm install ../codex-API
# o, si prefieres GitHub como origen:
# npm install git+https://github.com/<usuario>/codex-API.git
```

Si instalas desde el repositorio sin publicar, `prepare` recompila `dist/` antes de usarlo en el proyecto consumidor.

## Release

Para publicar una nueva versión en npm:

```bash
# Patch: 0.1.0 -> 0.1.1
npm run release:patch

# Minor: 0.1.1 -> 0.2.0
npm run release:minor

# Major: 0.1.0 -> 1.0.0
npm run release:major
```

Cada comando ejecuta tests, actualiza `version` y crea localmente el tag `vX.Y.Z`, luego publica el paquete.

Si quieres validar sin publicar:

```bash
npm run release:dry
```

Para release manual en GitHub también puedes crear un tag y luego un release desde el repositorio:

```bash
git tag v0.1.1
git push origin v0.1.1
git push
```

## Build y tests

```bash
npm run build
npm run test
```

El build genera `dist/` con JS ESM, `d.ts` y sourcemaps.

## Flujo recomendado

1. Crear o cargar `codex-auth.json` o `gemini-auth.json`
2. Construir el cliente con `createCodexClient` o `createGeminiClient`
3. Llamar `usage`, `listModels` o `responses` directamente

Si no pasas `authFile` ni defines variables de entorno, la librería usa:

- `./codex-auth.json` para Codex
- `./codex-sessions.json` para sesiones persistidas del backend CLI de Codex
- `./gemini-auth.json` para Gemini
- `./gemini-sessions.json` para sesiones persistidas del backend CLI de Gemini

## Uso básico Codex

```ts
import { createCodexAuth, createCodexClient } from "codex-openai-api";

const auth = createCodexAuth();

await auth.login();

const client = createCodexClient({
  auth,
  defaultInstructions: "Reply in one short sentence.",
});

const catalog = await client.listModels({ source: "auto" });
console.log(catalog.models.map((model) => model.id));

const result = await client.responses({
  model: "gpt-5.4",
  input: "hola",
});

console.log(result.outputText);
```

Para usar el backend local CLI:

```ts
const cliResult = await client.responses({
  backend: "cli",
  model: "gpt-5.4",
  sessionId: "my-chat",
  input: "Resume the last answer in Spanish.",
});
```

Notas prácticas de Codex:

- `usage()` y `listModels()` siguen usando el backend HTTP OAuth
- el backend `cli` sólo afecta `responses()` y `streamResponses()`
- `tools`, `toolChoice` e `includeEvents` no están soportados en el backend `cli` v1
- el backend `cli` usa el login nativo del binario `codex`, no `codex-auth.json`

## Codex backends

| Capability | `http` | `cli` |
| --- | --- | --- |
| Auth | OAuth guardado en `codex-auth.json` | login nativo de `codex` (`~/.codex` / Keychain) |
| Responses | Sí | Sí |
| `web_search` / tools | Sí | No |
| `includeEvents` | Sí | No |
| Persistencia de sesión | No | Sí, en `codex-sessions.json` |
| `usage()` / `listModels()` | Sí | No |

El backend `cli` es text-first: en fresh runs parsea JSONL para capturar `thread_id`, y en resume runs trata stdout como texto plano reutilizando el `sessionId` lógico persistido.

## Gemini quick start

```ts
import { createGeminiAuth, createGeminiClient } from "codex-openai-api";

const auth = createGeminiAuth();
await auth.login();

const client = createGeminiClient({
  auth,
  defaultBackend: "http",
  defaultInstructions: "Reply in one short paragraph.",
});

const catalog = await client.listModels({ source: "auto" });
console.log(catalog.models.map((model) => model.id));

const usage = await client.usage();
console.log(usage.windows);

const result = await client.responses({
  model: "flash",
  tools: [{ type: "web_search" }],
  input: "What happened today in AI?",
  includeEvents: true,
});

console.log(result.outputText);
console.log(result.events);
```

Para usar el backend local CLI:

```ts
const cliResult = await client.responses({
  backend: "cli",
  model: "pro",
  sessionId: "my-chat",
  input: "Resume the last answer in Spanish.",
});
```

Notas prácticas de Gemini:

- `listModels()` es estático en v1 aunque pases `source: "auto"` o `source: "static"`
- aliases como `pro`, `flash` y `flash-lite` se normalizan a ids canónicos internamente
- `usage()` separa cuotas agregadas en ventanas como `Pro` y `Flash`

## Gemini backends

| Capability | `http` | `cli` |
| --- | --- | --- |
| Auth | OAuth web guardado en `gemini-auth.json` | usa el mismo OAuth y ejecuta `gemini` local |
| Responses | Sí | Sí |
| `web_search` | Sí | No |
| `includeEvents` | Sí | No |
| Persistencia de sesión | No | Sí, en `gemini-sessions.json` |
| Catálogo de modelos | Estático en v1 | Estático en v1 |

El backend `http` traduce `tools: [{ type: "web_search" }]` a la herramienta nativa de búsqueda de Gemini. En v1, cualquier otra herramienta se rechaza explícitamente.

El backend `cli` es text-first: devuelve `outputText`, estado básico y reusa sesiones locales cuando envías el mismo `sessionId`.

## Uso con herramientas (`tools`)

`responses()` y `streamResponses()` aceptan herramientas upstream de forma genérica:

- `tools`: lista de herramientas que el modelo puede usar
- `toolChoice`: controla si el modelo decide automaticamente o si debe usar una herramienta

La libreria reenvia estos campos al upstream de Codex sin transformarlos, excepto por el nombre del campo `toolChoice`, que se serializa como `tool_choice` para el request HTTP.

```ts
const result = await client.responses({
  model: "gpt-5.4",
  input: "Resuelve esto usando herramientas si hace falta",
  tools: [{ type: "web_search" }],
  toolChoice: "auto",
});
```

Valores comunes de `toolChoice`:

- `"auto"`: el modelo decide si usar la herramienta
- `"required"`: obliga al modelo a usar una herramienta
- `"none"`: desactiva el uso de herramientas en esa llamada

## Uso con `web_search`

`web_search` no se activa por elegir `gpt-5.4` solamente. Debes enviar la herramienta en el payload.

```ts
import { createCodexAuth, createCodexClient } from "codex-openai-api";

const auth = createCodexAuth();
await auth.login();

const client = createCodexClient({ auth });

const result = await client.responses({
  model: "gpt-5.4",
  tools: [{ type: "web_search" }],
  input: "What happened today in AI?",
  includeEvents: true,
});

console.log(result.outputText);
console.log(result.events);
```

Que esperar de este flujo:

- `outputText` contiene la respuesta final en texto plano
- `includeEvents: true` agrega `events` para inspeccionar el stream SSE completo
- cuando `web_search` se ejecuta de verdad, el stream puede incluir eventos como `response.web_search_call.in_progress`, `response.web_search_call.searching` y `response.web_search_call.completed`
- las citas pueden venir embebidas en el texto o dentro de los eventos upstream; esta libreria no las normaliza todavia

Ejemplo de verificacion real:

```ts
const result = await client.responses({
  model: "gpt-5.4",
  tools: [{ type: "web_search" }],
  input: "What was a positive AI news story from today?",
  includeEvents: true,
});

console.log(result.status); // 200 si el upstream acepta la herramienta
console.log(result.outputText);
console.log(
  result.events
    ?.map((event) => (event && typeof event === "object" ? (event as { type?: string }).type : undefined))
    .filter(Boolean),
);
```

Notas practicas:

- si no envias `tools`, la llamada se comporta como antes y no intenta usar herramientas
- `web_search` depende de que el upstream acepte esa herramienta para el modelo y la cuenta autenticada
- si quieres depurar rechazos del upstream, revisa `status` y `body` en la respuesta
- si quieres procesar citas o metadata de busqueda, la fuente mas completa hoy es `events`

## Elegir otra ruta para el auth file

```ts
import { createCodexAuth } from "codex-openai-api";

const auth = createCodexAuth({
  authFile: "/absolute/path/to/codex-auth.json",
});

const client = createCodexClient({
  auth,
  sessionFile: "/absolute/path/to/codex-sessions.json",
  cliCommand: "/absolute/path/to/codex",
});
```

También puedes usar:

```bash
export CODEX_AUTH_FILE=/absolute/path/to/codex-auth.json
```

Para Gemini:

```ts
import { createGeminiAuth, createGeminiClient } from "codex-openai-api";

const auth = createGeminiAuth({
  authFile: "/absolute/path/to/gemini-auth.json",
});

const client = createGeminiClient({
  auth,
  sessionFile: "/absolute/path/to/gemini-sessions.json",
  cliCommand: "/absolute/path/to/gemini",
});
```

## API disponible

### `createCodexAuth`

Expone:

- `authFile`
- `loadCredential()`
- `saveCredential()`
- `login()`
- `getFreshCredential()`

`login()` sigue siendo el mecanismo oficial para obtener o regenerar `codex-auth.json`, incluyendo callbacks interactivos opcionales.

### `createGeminiAuth`

Expone:

- `authFile`
- `loadCredential()`
- `saveCredential()`
- `login()`
- `getFreshCredential()`

`login()` abre un flujo OAuth web con callback en `http://localhost:8085/oauth2callback`. Si ese callback falla o no está disponible, la librería cae a entrada manual del redirect URL o del authorization code.

### `createCodexClient`

Expone:

- `usage()`
- `listModels({ source })`
- `responses({ input, model, instructions, backend, sessionId, tools, toolChoice })`
- `streamResponses({ input, model, instructions, backend, sessionId, tools, toolChoice })`

`backend` soporta:

- `"http"`: Codex HTTP con OAuth y SSE
- `"cli"`: subprocess local `codex` con persistencia de sesiones

`listModels({ source: "auto" })` intenta catálogo live cuando hay credencial válida y cae a catálogo estático cuando no.

`responses()` resuelve el stream completo y devuelve:

- `status`
- `outputText`
- `responseState`
- `events` cuando usas `includeEvents: true`
- `body` cuando el upstream responde con error serializable

En backend `cli`, `responseState` también incluye `backend: "cli"` y el `sessionId` persistido cuando se pudo resolver el thread real de Codex.

### `createGeminiClient`

Expone:

- `usage()`
- `listModels({ source })`
- `responses({ input, model, instructions, backend, sessionId, tools, toolChoice })`
- `streamResponses({ input, model, instructions, backend, sessionId, tools, toolChoice })`

`backend` soporta:

- `"http"`: Gemini HTTP con OAuth y SSE
- `"cli"`: subprocess local `gemini` con persistencia de sesiones

`responses()` devuelve:

- `status`
- `outputText`
- `responseState`
- `events` cuando usas `includeEvents: true` en backend `http`
- `body` cuando el upstream o el CLI devuelven un error serializable

## Variables de entorno

- `CODEX_AUTH_FILE`: ruta del archivo OAuth
- `CODEX_SESSION_FILE`: ruta del archivo de sesiones CLI de Codex
- `CODEX_MODEL`: modelo por defecto para requests upstream
- `CODEX_RESPONSES_URL`: endpoint upstream de Codex Responses
- `CODEX_INSTRUCTIONS`: instrucciones por defecto
- `CODEX_CLIENT_VERSION`: `client_version` usado para el catálogo live
- `CODEX_CLI_PATH`: ruta del binario `codex`
- `GEMINI_AUTH_FILE`: ruta del archivo OAuth Gemini
- `GEMINI_SESSION_FILE`: ruta del archivo de sesiones CLI Gemini
- `GEMINI_MODEL`: modelo Gemini por defecto
- `GEMINI_INSTRUCTIONS`: instrucciones Gemini por defecto
- `GEMINI_RESPONSES_BASE_URL`: base URL del backend HTTP Gemini
- `GEMINI_CLI_PATH`: ruta del binario `gemini`
- `GEMINI_CLI_OAUTH_CLIENT_ID`: client id OAuth preferido para Gemini
- `GEMINI_CLI_OAUTH_CLIENT_SECRET`: client secret OAuth preferido para Gemini
- `OPENCLAW_GEMINI_OAUTH_CLIENT_ID`: alias compatible con OpenClaw
- `OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET`: alias compatible con OpenClaw

## Migración desde el enfoque anterior

Este release elimina intencionalmente:

- el CLI `codex-openai-api`
- el servidor HTTP local
- la superficie OpenAI-compatible del proxy

La migración esperada es reemplazar cualquier uso de `serve`, `curl http://127.0.0.1:8787/...` o `createCodexServer(...)` por llamadas directas a `createCodexAuth()` y `createCodexClient()`.

## Notas

- Esto usa el bearer OAuth de Codex, no `OPENAI_API_KEY`.
- `responses()` trabaja directo contra el upstream de Codex; no existe capa HTTP local intermedia.
- El backend CLI de Codex requiere que `codex` esté instalado localmente y autenticado por su propio mecanismo.
- La integración Gemini usa OAuth web y endpoints observados en tooling existente; no es un SDK oficial de Google para producción endurecida.
- El backend CLI de Gemini requiere que `gemini` esté instalado localmente y accesible por `PATH` o `GEMINI_CLI_PATH`.
