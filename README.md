# codex-openai-api

Proyecto standalone para usar Codex OAuth como backend de un API local estilo GPT.

Expone:

- una librería TypeScript reusable
- un CLI para login y diagnóstico
- un servidor HTTP compatible con `POST /v1/responses`

El objetivo es usar la cuenta OAuth de Codex como upstream real y presentar una superficie local parecida a OpenAI Responses.

## Estructura

- `src/auth.ts`: login OAuth, persistencia local y refresh
- `src/client.ts`: cliente upstream para `usage`, `listModels`, `responses` y streaming SSE
- `src/openai-responses.ts`: traducción entre OpenAI Responses y el payload de Codex
- `src/server.ts`: servidor HTTP local con bearer auth
- `src/cli.ts`: binario `codex-openai-api`
- `test/*.test.ts`: suite unitaria y de servidor

## Instalar

Dentro de `tmp/codex-auth`:

```bash
npm install
```

## Build y tests

```bash
npm run build
npm run test
```

El build genera `dist/` con `d.ts`, JS ESM y sourcemaps.

## Login OAuth

```bash
node dist/cli.js login
```

La credencial se guarda por defecto en `./codex-auth.json`.

También puedes verificar el estado local:

```bash
node dist/cli.js dry
```

## Servidor HTTP local

Arranque mínimo:

```bash
CODEX_SERVER_API_KEY=replace-me node dist/cli.js serve
```

Defaults:

- host: `127.0.0.1`
- port: `8787`
- auth entrante: `Authorization: Bearer <CODEX_SERVER_API_KEY>`

Flags opcionales:

```bash
node dist/cli.js serve --host 127.0.0.1 --port 8787 --api-key replace-me
```

## Endpoints

- `GET /healthz`
- `GET /v1/models`
- `GET /v1/models/:id`
- `POST /v1/responses`

`/v1/models` y `/v1/models/:id` devuelven objetos estilo OpenAI más metadata de Codex:

- `default_reasoning_level`
- `supported_reasoning_levels`
- `max_reasoning_level`
- `input_modalities`
- `context_window`
- `supports_parallel_tool_calls`
- `supports_verbosity`

## Ejemplos con curl

Health:

```bash
curl -sS http://127.0.0.1:8787/healthz \
  -H 'Authorization: Bearer replace-me'
```

Modelos:

```bash
curl -sS http://127.0.0.1:8787/v1/models \
  -H 'Authorization: Bearer replace-me'
```

Respuesta no streaming:

```bash
curl -sS http://127.0.0.1:8787/v1/responses \
  -H 'Authorization: Bearer replace-me' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-5.2",
    "input": "hola"
  }'
```

Respuesta streaming:

```bash
curl -N http://127.0.0.1:8787/v1/responses \
  -H 'Authorization: Bearer replace-me' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-5.2",
    "stream": true,
    "input": "hola"
  }'
```

El stream usa la familia de eventos:

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`
- `response.failed`
- `data: [DONE]`

## Ejemplo con OpenAI SDK

```ts
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.CODEX_SERVER_API_KEY,
  baseURL: "http://127.0.0.1:8787/v1",
});

const response = await client.responses.create({
  model: "gpt-5.2",
  input: "hola",
});

console.log(response.output_text);
```

## Uso como librería

```ts
import {
  createCodexAuth,
  createCodexClient,
  createCodexServer,
} from "./dist/index.js";

const auth = createCodexAuth({
  authFile: "./codex-auth.json",
});

const client = createCodexClient({
  auth,
  defaultInstructions: "Reply in one short sentence.",
});

const catalog = await client.listModels({ source: "auto" });
console.log(catalog.models.map((model) => model.id));

const result = await client.responses({
  model: "gpt-5.2",
  input: "hola",
});
console.log(result.outputText);

const server = createCodexServer({
  auth,
  apiKey: "replace-me",
});
await server.listen();
```

## CLI adicional

Consultar uso upstream:

```bash
node dist/cli.js usage
```

Listar modelos y niveles de razonamiento:

```bash
node dist/cli.js list-models
node dist/cli.js list-models --source static
node dist/cli.js list-models --source live --client-version 0.64.0
```

Llamar directo al upstream Codex sin pasar por el servidor local:

```bash
node dist/cli.js responses "hola" --model gpt-5.2
```

## Variables de entorno

- `CODEX_AUTH_FILE`: archivo de credenciales OAuth
- `CODEX_MODEL`: modelo por defecto para requests upstream
- `CODEX_RESPONSES_URL`: endpoint upstream de Codex Responses
- `CODEX_INSTRUCTIONS`: instrucciones por defecto
- `CODEX_CLIENT_VERSION`: `client_version` usado para el catálogo live
- `CODEX_SERVER_API_KEY`: bearer key requerido por el servidor local
- `CODEX_SERVER_HOST`: host del servidor local
- `CODEX_SERVER_PORT`: puerto del servidor local

## Notas

- Esto usa el bearer OAuth de Codex, no `OPENAI_API_KEY`.
- En v1, `/v1/responses` soporta texto y `message` items de texto. No incluye tools, files, images ni `chat/completions`.
- El campo `reasoning` se reconoce en el catálogo de modelos; no se promete todavía como control de ejecución hacia upstream.
