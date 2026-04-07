# codex-openai-api

Proyecto standalone para usar Codex OAuth como librería TypeScript directa.

La superficie pública queda enfocada en dos piezas:

- `createCodexAuth`: login OAuth, persistencia local y refresh
- `createCodexClient`: acceso directo a `usage`, `listModels`, `responses` y streaming SSE

El contrato operativo principal es `codex-auth.json`.

## Instalar

```bash
npm install
```

## Build y tests

```bash
npm run build
npm run test
```

El build genera `dist/` con JS ESM, `d.ts` y sourcemaps.

## Flujo recomendado

1. Crear o cargar `codex-auth.json`
2. Construir el cliente con `createCodexClient`
3. Llamar `usage`, `listModels` o `responses` directamente

Si no pasas `authFile` ni defines `CODEX_AUTH_FILE`, la librería usa `./codex-auth.json` en el directorio actual.

## Uso básico

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
```

También puedes usar:

```bash
export CODEX_AUTH_FILE=/absolute/path/to/codex-auth.json
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

### `createCodexClient`

Expone:

- `usage()`
- `listModels({ source })`
- `responses({ input, model, instructions, tools, toolChoice })`
- `streamResponses({ input, model, instructions, tools, toolChoice })`

`listModels({ source: "auto" })` intenta catálogo live cuando hay credencial válida y cae a catálogo estático cuando no.

`responses()` resuelve el stream completo y devuelve:

- `status`
- `outputText`
- `responseState`
- `events` cuando usas `includeEvents: true`
- `body` cuando el upstream responde con error serializable

## Variables de entorno

- `CODEX_AUTH_FILE`: ruta del archivo OAuth
- `CODEX_MODEL`: modelo por defecto para requests upstream
- `CODEX_RESPONSES_URL`: endpoint upstream de Codex Responses
- `CODEX_INSTRUCTIONS`: instrucciones por defecto
- `CODEX_CLIENT_VERSION`: `client_version` usado para el catálogo live

## Migración desde el enfoque anterior

Este release elimina intencionalmente:

- el CLI `codex-openai-api`
- el servidor HTTP local
- la superficie OpenAI-compatible del proxy

La migración esperada es reemplazar cualquier uso de `serve`, `curl http://127.0.0.1:8787/...` o `createCodexServer(...)` por llamadas directas a `createCodexAuth()` y `createCodexClient()`.

## Notas

- Esto usa el bearer OAuth de Codex, no `OPENAI_API_KEY`.
- `responses()` trabaja directo contra el upstream de Codex; no existe capa HTTP local intermedia.
