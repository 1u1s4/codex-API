# codex-openai-api

SDK TypeScript para usar Codex Responses con OAuth, streaming SSE y herramientas upstream.

[![npm version](https://img.shields.io/npm/v/codex-openai-api?logo=npm)](https://www.npmjs.com/package/codex-openai-api)
[![npm downloads](https://img.shields.io/npm/dm/codex-openai-api?logo=npm)](https://www.npmjs.com/package/codex-openai-api)
[![Node >=22](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![release workflow](https://img.shields.io/github/actions/workflow/status/1u1s4/codex-API/release.yml?label=release)](https://github.com/1u1s4/codex-API/actions/workflows/release.yml)
[![license](https://img.shields.io/github/license/1u1s4/codex-API)](https://github.com/1u1s4/codex-API/blob/main/LICENSE)

## Qué es

`codex-openai-api` es una librería TypeScript para autenticar con OAuth y consumir Codex Responses desde una API simple, tipada y reutilizable.

Incluye soporte para:

- login OAuth y refresh de credenciales
- requests al endpoint Codex Responses
- respuestas en streaming SSE
- herramientas upstream como `web_search`
- catálogo de modelos
- control explícito de `reasoningEffort`

Contrato operativo principal:

- `codex-auth.json`

## Cuándo sirve

Úsalo si quieres:

- integrar Codex Responses en una app o servicio TypeScript
- reutilizar credenciales OAuth sin repetir el login manualmente
- trabajar con streaming SSE y tools desde una superficie tipada
- instalar el cliente como paquete npm en otros proyectos

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

## Uso con herramientas

```ts
const result = await client.responses({
  model: "gpt-5.4",
  input: "Busca una noticia reciente de IA y resúmela en una frase.",
  tools: [{ type: "web_search" }],
  toolChoice: "auto",
});
```

La librería reenvía estos campos al upstream de Codex casi sin transformación. La principal adaptación es `toolChoice`, que se serializa como `tool_choice` en HTTP.

## Control de razonamiento

`reasoningEffort` permite controlar el esfuerzo de razonamiento de forma explícita.

Se serializa como `reasoning.effort` en el payload de Codex Responses.

```ts
const result = await client.responses({
  model: "gpt-5.4",
  input: "Resume esto en una frase.",
  reasoningEffort: "low",
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
- `responsesEndpoint`
- `usage()`
- `listModels({ source })`
- `responses({ input, model, instructions, reasoningEffort, tools, toolChoice, includeEvents })`
- `streamResponses({ input, model, instructions, reasoningEffort, tools, toolChoice })`

`responses()` devuelve:

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
6. GitHub Actions genera release notes en español automáticamente
7. GitHub Actions crea el GitHub Release

Si quieres validar el paquete sin publicar:

```bash
npm run release:dry
```

## Notas

- El acceso al backend upstream depende de que la cuenta autenticada tenga acceso al modelo y a las herramientas solicitadas.
- El proyecto está publicado en npm como `codex-openai-api`.
