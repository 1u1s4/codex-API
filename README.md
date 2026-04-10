# codex-openai-api

Proyecto standalone para usar **Codex OAuth** como librería TypeScript directa.

[![npm version](https://img.shields.io/npm/v/codex-openai-api?logo=npm)](https://www.npmjs.com/package/codex-openai-api)
[![npm downloads](https://img.shields.io/npm/dm/codex-openai-api?logo=npm)](https://www.npmjs.com/package/codex-openai-api)
[![Node >=22](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![release workflow](https://img.shields.io/github/actions/workflow/status/1u1s4/codex-API/release.yml?label=release)](https://github.com/1u1s4/codex-API/actions/workflows/release.yml)
[![license](https://img.shields.io/github/license/1u1s4/codex-API)](https://github.com/1u1s4/codex-API/blob/main/LICENSE)

**Tags:** `codex` · `oauth` · `typescript` · `sse` · `http-client`

## Índice rápido

- [Instalar](#instalar)
- [Release](#release)
- [Build y tests](#build-y-tests)
- [Flujo recomendado](#flujo-recomendado)
- [Uso básico Codex](#uso-básico-codex)
- [Uso con herramientas](#uso-con-herramientas)
- [Uso con `web_search`](#uso-con-web_search)
- [API disponible](#api-disponible)
- [Variables de entorno](#variables-de-entorno)

## ¿Qué incluye?

La superficie pública queda enfocada en cuatro piezas:

- `createCodexAuth`: login OAuth, persistencia local y refresh
- `createCodexClient`: acceso Codex por HTTP OAuth o por `codex` CLI local
- catálogo de modelos Codex
- tipos compartidos del cliente Codex

Contratos operativos principales: `codex-auth.json` y `codex-sessions.json`.

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

Usa `release:major` para publicar este cambio incompatible, porque rompe la API pública anterior.

Si quieres validar sin publicar:

```bash
npm run release:dry
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

Si no pasas `authFile` ni defines variables de entorno, la librería usa:

- `./codex-auth.json` para OAuth
- `./codex-sessions.json` para sesiones persistidas del backend CLI

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

## Codex backends

| Capability | `http` | `cli` |
| --- | --- | --- |
| Auth | OAuth guardado en `codex-auth.json` | login nativo de `codex` (`~/.codex` / Keychain) |
| Responses | Sí | Sí |
| `web_search` / tools | Sí | No |
| `includeEvents` | Sí | No |
| Persistencia de sesión | No | Sí, en `codex-sessions.json` |
| `usage()` / `listModels()` | Sí | No |

Notas prácticas:

- `usage()` y `listModels()` siguen usando el backend HTTP OAuth
- el backend `cli` sólo afecta `responses()` y `streamResponses()`
- `tools`, `toolChoice` e `includeEvents` no están soportados en el backend `cli` v1
- el backend `cli` usa el login nativo del binario `codex`, no `codex-auth.json`

## Uso con herramientas

- `responses()` y `streamResponses()` aceptan herramientas upstream de forma genérica:

- `tools`: lista de herramientas que el modelo puede usar
- `toolChoice`: controla si el modelo decide automáticamente o si debe usar una herramienta
- `reasoningEffort`: ajusta `reasoning.effort` en HTTP y `model_reasoning_effort` en CLI
- `serviceTier`: reenvía `service_tier` al upstream HTTP y usa `--config service_tier=...` en CLI

La librería reenvía estos campos al upstream de Codex sin transformarlos, excepto por `toolChoice`, que se serializa como `tool_choice` en el request HTTP.

```ts
const result = await client.responses({
  model: "gpt-5.4",
  input: "Resuelve esto usando herramientas si hace falta",
  reasoningEffort: "low",
  tools: [{ type: "web_search" }],
  toolChoice: "auto",
});
```

## Uso estilo `/fast` con `gpt-5.4`

En `codex exec`, `/fast` no se interpreta como slash command real: se envía como texto del prompt.
Para exponer un modo equivalente desde esta librería, usa `serviceTier` y opcionalmente `reasoningEffort`.

```ts
const fastResult = await client.responses({
  backend: "cli",
  model: "gpt-5.4",
  input: "Resume esto en una frase.",
  serviceTier: "fast",
});
```

Notas prácticas:

- en backend `cli`, `serviceTier: "fast"` agrega `--config service_tier="fast"`
- si el modelo es `gpt-5.4` y no indicas `reasoningEffort`, la librería fuerza `model_reasoning_effort="low"` para acercarse al comportamiento esperado de `/fast`
- si quieres controlar explícitamente el nivel de razonamiento, pasa `reasoningEffort` (`"none"`, `"low"`, etc.)

## Uso con `web_search`

`web_search` no se activa por elegir un modelo. Debes enviar la herramienta en el payload del backend HTTP.

```ts
const result = await client.responses({
  backend: "http",
  model: "gpt-5.4",
  input: "Busca una noticia reciente de IA y resúmela en una frase.",
  tools: [{ type: "web_search" }],
  toolChoice: "auto",
  includeEvents: true,
});
```

El stream puede incluir eventos como `response.web_search_call.in_progress`, `response.web_search_call.searching` y `response.web_search_call.completed`, además del texto final.

## API disponible

### `createCodexAuth`

Expone:

- `authFile`
- `loadCredential()`
- `saveCredential(credential)`
- `login()`
- `getFreshCredential()`

### `createCodexClient`

Expone:

- `defaultModel`
- `defaultInstructions`
- `defaultBackend`
- `responsesUrl`
- `sessionFile`
- `cliCommand`
- `usage()`
- `listModels({ source })`
- `responses({ input, model, instructions, backend, sessionId, reasoningEffort, serviceTier, tools, toolChoice, includeEvents })`
- `streamResponses({ input, model, instructions, backend, sessionId, reasoningEffort, serviceTier, tools, toolChoice })`

`backend` soporta:

- `"http"`: Codex Responses por HTTP
- `"cli"`: subprocess local `codex` con persistencia de sesiones

`responses()` devuelve:

- `status`
- `outputText`
- `responseState`
- `events` cuando usas `includeEvents: true`
- `body` cuando el upstream responde con error serializable

En backend `cli`, `responseState` también incluye `backend: "cli"` y el `sessionId` persistido cuando se pudo resolver el thread real de Codex.

## Variables de entorno

- `CODEX_AUTH_FILE`: ruta del archivo OAuth
- `CODEX_SESSION_FILE`: ruta del archivo de sesiones CLI
- `CODEX_MODEL`: modelo por defecto para requests upstream
- `CODEX_RESPONSES_URL`: endpoint upstream de Codex Responses
- `CODEX_INSTRUCTIONS`: instrucciones por defecto
- `CODEX_CLIENT_VERSION`: `client_version` usado para el catálogo live
- `CODEX_CLI_PATH`: ruta del binario `codex`

## Notas

- El backend HTTP depende de que la cuenta autenticada tenga acceso al modelo y a las herramientas solicitadas.
- El backend CLI requiere que `codex` esté instalado localmente y accesible por `PATH` o `CODEX_CLI_PATH`.
- Este paquete ahora expone únicamente la integración Codex.
