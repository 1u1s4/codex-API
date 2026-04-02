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
- `responses({ input, model, instructions })`
- `streamResponses({ input, model, instructions })`

`listModels({ source: "auto" })` intenta catálogo live cuando hay credencial válida y cae a catálogo estático cuando no.

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
