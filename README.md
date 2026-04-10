# codex-openai-api

Librería TypeScript para acceder a Codex por OAuth, HTTP y CLI desde un solo cliente.

[![npm version](https://img.shields.io/npm/v/codex-openai-api?logo=npm)](https://www.npmjs.com/package/codex-openai-api)
[![npm downloads](https://img.shields.io/npm/dm/codex-openai-api?logo=npm)](https://www.npmjs.com/package/codex-openai-api)
[![Node >=22](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![release workflow](https://img.shields.io/github/actions/workflow/status/1u1s4/codex-API/release.yml?label=release)](https://github.com/1u1s4/codex-API/actions/workflows/release.yml)
[![license](https://img.shields.io/github/license/1u1s4/codex-API)](https://github.com/1u1s4/codex-API/blob/main/LICENSE)

## Qué es

`codex-openai-api` envuelve el flujo de autenticación de Codex y expone una API simple para:

- autenticar por OAuth y refrescar credenciales
- usar el backend HTTP de Codex Responses
- usar el backend local `codex` CLI con sesiones persistentes
- consultar catálogo de modelos
- trabajar con herramientas upstream como `web_search`
- controlar el esfuerzo de razonamiento con `reasoningEffort`

Contratos operativos principales:

- `codex-auth.json`
- `codex-sessions.json`

## Cuándo sirve

Úsalo si quieres:

- integrar Codex en una app o script TypeScript
- reutilizar login OAuth sin depender manualmente del navegador cada vez
- alternar entre backend HTTP y backend CLI con una superficie común
- instalar el paquete desde npm en otros proyectos

## Instalación

```bash
npm install codex-openai-api
```

También puedes consumirlo desde un checkout local:

```bash
npm install ../codex-API
```

Si lo instalas desde el repositorio sin publicar, `prepare` recompila `dist/` automáticamente.

## Inicio rápido

```ts
import { createCodexAuth, createCodexClient } from "codex-openai-api";

const auth = createCodexAuth();
await auth.login();

const client = createCodexClient({
  auth,
  defaultInstructions: "Responde en una sola frase.",
});

const result = await client.responses({
  model: "gpt-5.4",
  input: "Hola",
});

console.log(result.outputText);
```

## Backend HTTP vs CLI

| Capacidad | `http` | `cli` |
| --- | --- | --- |
| Autenticación | OAuth guardado en `codex-auth.json` | login nativo de `codex` |
| `responses()` | Sí | Sí |
| `streamResponses()` | Sí | Sí |
| Herramientas upstream | Sí | No |
| `web_search` | Sí | No |
| `includeEvents` | Sí | No |
| Persistencia de sesión | No | Sí, en `codex-sessions.json` |
| `usage()` | Sí | No |
| `listModels()` | Sí | No |

Notas prácticas:

- `usage()` y `listModels()` siguen usando el backend HTTP OAuth.
- El backend `cli` solo afecta `responses()` y `streamResponses()`.
- `tools`, `toolChoice` e `includeEvents` no están soportados en `cli` v1.
- El backend `cli` usa el login del binario `codex`, no `codex-auth.json`.

## Uso básico con backend CLI

```ts
const client = createCodexClient();

const result = await client.responses({
  backend: "cli",
  model: "gpt-5.4",
  sessionId: "mi-chat",
  input: "Resume la última respuesta en español.",
});
```

## Uso con herramientas

```ts
const result = await client.responses({
  model: "gpt-5.4",
  input: "Busca una noticia reciente de IA y resúmela en una frase.",
  tools: [{ type: "web_search" }],
  toolChoice: "auto",
});
```

La librería reenvía estos campos al upstream de Codex casi sin transformación. La única adaptación relevante es `toolChoice`, que se serializa como `tool_choice` en HTTP.

## Control de razonamiento

`reasoningEffort` permite controlar el esfuerzo de razonamiento con una API explícita y consistente:

- en HTTP se serializa como `reasoning.effort`
- en CLI se envía como `--config model_reasoning_effort=...`

Ejemplo:

```ts
const result = await client.responses({
  model: "gpt-5.4",
  input: "Resume esto en una frase.",
  reasoningEffort: "low",
});
```

### Nota sobre `/fast`

`/fast` no se interpreta como slash command real dentro de `codex exec` en esta integración. Si lo incluyes en el prompt, se envía como texto normal.

Si quieres controlar velocidad o profundidad de razonamiento, usa `reasoningEffort` explícitamente:

```ts
const result = await client.responses({
  backend: "cli",
  model: "gpt-5.4",
  input: "Resume esto en una frase.",
  reasoningEffort: "none",
});
```

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
- `responses({ input, model, instructions, backend, sessionId, reasoningEffort, tools, toolChoice, includeEvents })`
- `streamResponses({ input, model, instructions, backend, sessionId, reasoningEffort, tools, toolChoice })`

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

## Build y tests

```bash
npm run build
npm run test
```

El build genera `dist/` con JS ESM, `d.ts` y sourcemaps.

## Releases

Para publicar una nueva versión:

```bash
npm run release:patch
npm run release:minor
npm run release:major
```

Flujo recomendado:

1. corre tests
2. actualiza `version`
3. crea el tag `vX.Y.Z`
4. hace push del commit y del tag
5. GitHub Actions publica en npm con `NPM_TOKEN`
6. GitHub Actions crea el GitHub Release

Si quieres validar el paquete sin publicar:

```bash
npm run release:dry
```

## Notas

- El backend HTTP depende de que la cuenta autenticada tenga acceso al modelo y a las herramientas solicitadas.
- El backend CLI requiere que `codex` esté instalado localmente y accesible por `PATH` o `CODEX_CLI_PATH`.
- El proyecto está publicado en npm como `codex-openai-api`.
