---
name: mcpTaiga
description: Operar el Taiga MCP de este repo — levantarlo en Docker y leer o escribir épicas, historias y tareas del proyecto en Taiga. Usar cuando se pida revisar, cargar o corregir épicas/HU/tareas en Taiga, cuando los tools mcp__taiga__* fallen o no aparezcan, o cuando se nombre "/mcpTaiga", "taiga", "el MCP de taiga", "backlog", "sprint" o "épicas del grupo".
---

# Taiga MCP

Servidor MCP que expone la API de Taiga como tools. Vive en `taiga-mcp/` y el cliente lo
consume por HTTP en `http://localhost:8010/mcp/`.

## Paso 1 — el contenedor, siempre primero

**Antes de cualquier otra cosa**, asegurá que el servidor responde. Sin esto los tools
`mcp__taiga__*` no existen o fallan con `ConnectionRefused`.

```bash
curl -s -m 5 http://localhost:8010/healthz     # responde: ok
```

Si no responde, levantalo con compose desde `taiga-mcp/`:

```bash
cd taiga-mcp
docker compose up -d --build
docker compose ps          # esperá "Up (healthy)"
```

El contenedor escucha en 8000 y compose lo publica en **8010**, que es el puerto que espera
la config MCP del cliente. No cambies ese mapeo sin cambiar también la config.

Casos que vas a encontrar, en orden de probabilidad:

| Síntoma | Causa | Qué hacer |
|---|---|---|
| `ConnectionRefused` al arrancar la sesión | Docker Desktop apagado | Abrir Docker Desktop, después `docker compose up -d` |
| `healthz` no responde pero el contenedor figura Up | Todavía arrancando | Esperar el `start_period` de 10 s |
| `Conflict. The container name "/taiga-mcp" is already in use` | Quedó un contenedor viejo creado fuera de compose | `docker rm -f taiga-mcp` y repetir. No tiene estado: todo vive en Taiga |
| El servidor responde pero devuelve datos viejos o le faltan arreglos | La imagen quedó vieja | `docker compose up -d --build` reconstruye desde el código actual |

Los tools del MCP se registran al conectar el cliente. Si levantaste el contenedor **después**
de arrancar la sesión, los `mcp__taiga__*` pueden seguir sin aparecer: reconectá con `/mcp`.
Mientras tanto podés hablarle por HTTP directo al endpoint streamable.

**Nunca levantes el servidor a mano con `uvicorn` o un venv suelto** si Docker está disponible:
queda un segundo proceso peleando por el 8010 y es imposible saber cuál atiende.

## Configuración

`taiga-mcp/.env` (copiar de `.env.example`). Las tres primeras son obligatorias o el servidor
no arranca:

- `TAIGA_BASE_URL` — `https://api.taiga.io` para la instancia pública
- `TAIGA_USERNAME` / `TAIGA_PASSWORD` — cuenta de servicio; **nunca commitear este archivo**
- `TAIGA_PROFILE` — `ide` (desarrollo), `chatgpt` o `builder`
- `TAIGA_DESTRUCTIVE_MODE` — `off` por defecto. Con `off` **los tools de borrado no existen**:
  si hace falta borrar algo, se pide antes, no se cambia el flag por cuenta propia
- `TAIGA_PROJECT_ID` / `TAIGA_PROJECT_SLUG` — opcionales, evitan pasar `project_id` siempre

`taiga_diagnostics` confirma a qué instancia apunta, con qué usuario y qué perfil, sin exponer
la contraseña. Es el primer tool a llamar si algo se comporta raro.

## Modelo de datos

Un **proyecto** contiene **épicas**, **historias de usuario** y, colgando de cada historia,
**tareas**. La relación épica↔historia es muchos a muchos y vive en un endpoint aparte
(`taiga_epics_add_user_story`), no en un campo de la historia. Cada objeto tiene un `id`
interno y un `ref` visible (el `#76` que se ve en la UI); **los tools toman `id`, la gente
habla en `ref`**, así que traducí siempre antes de escribir.

Ojo: el proyecto puede ser compartido por varios grupos. Filtrá por prefijo de título o por
épica antes de sacar conclusiones sobre "todo lo que hay".

## Trampas conocidas

Estas cuestan horas si no se saben. Están verificadas contra este servidor.

**La paginación miente.** `taiga_stories_list` fuerza `page_size` (50 por defecto, 100 máximo)
y no informa el total, así que una lista "completa" puede estar cortada sin ningún aviso. Para
recorrer todo, paginá con `page=1,2,3…` hasta que Taiga responda **404** — ese 404 es el fin de
la lista, no un error. `taiga_epics_list` y `taiga_users_list` sí traen la colección entera
(usan `x-disable-pagination`), pero `epics_list` recorta en memoria si le pasás `page_size`.

**`taiga_tasks_list` nunca devuelve `description`.** Declara el campo, pero la API de Taiga no
lo manda en los listados y vuelve siempre vacío. Para leer la descripción de una tarea hay que
pedirla con `taiga_tasks_get`. Si validás descripciones con el listado, te da un falso negativo
en el 100% de los casos.

**`taiga_tasks_list` devuelve un dict, no una lista**: `{"tasks": [...], "pagination": {...}}`.
Los demás `*_list` devuelven lista.

**Un item, un `TextContent`.** Los tools de colección mandan un bloque por elemento, no un
array JSON. Parseá todos los bloques; con cero elementos el contenido viene vacío.

**Campos que ningún tool expone.** `points`, `watchers`, `assigned_to` y desvincular una
historia de una épica no están en los tools de update. Van con `PATCH` directo usando el
cliente del repo (`taiga_client.get_taiga_client`), y Taiga exige mandar el `version` actual
del objeto o rechaza la escritura por control de concurrencia.

**Los puntos son `{role_id: point_id}`**, no un número. Los `point_id` salen de la escala del
proyecto; la forma más rápida de descubrirlos es leer una historia que ya tenga ese valor.

**Un error de tool sin mensaje casi siempre es un 5xx de Taiga.** `api.taiga.io` se cae seguido
y el servidor no propaga el detalle, así que llega un `Error executing tool X:` pelado.
Reintentá con backoff en vez de darlo por error de negocio. Un `ReadTimeout` o un `503` es lo
mismo: esperá y repetí.

**Abrí una sesión MCP por llamada.** El transporte streamable corta las sesiones largas; si
encadenás muchas llamadas en una sola sesión, se cae a la mitad.

## Escribir sin romper nada

1. **Leé antes de escribir.** `taiga_epics_get` / `taiga_stories_get` traen el estado real;
   los listados traen campos recortados.
2. **Guardá un backup** del `subject` y la `description` de lo que vas a tocar, en un archivo
   del scratchpad. Taiga no tiene deshacer.
3. **Hacé los scripts idempotentes**, con la comparación por el valor final. Taiga se cae a
   mitad de una corrida y vas a tener que repetirla.
4. **Reescribí en sitio, no borres y recrees.** Al recrear se pierden el `ref` y el historial,
   y otros equipos citan esos números.
5. **Verificá releyendo desde Taiga**, no desde lo que creés que mandaste. Un `200 OK` no
   garantiza que el campo se haya guardado.
6. **No toques asignaciones de personas** salvo pedido explícito: el reparto se hace en
   planning con la capacidad de cada uno.

## Convenciones de la cátedra

Las descripciones de épicas e historias **deben** seguir las plantillas de la wiki del
proyecto, y eso se califica. Traelas con el cliente del repo (`GET /wiki?project=<id>`; no hay
tool de wiki) y respetalas al pie:

- `template-epicas` — Objetivo · Suposiciones y Restricciones · Criterios de Aceptación a nivel
  Épico (5 ítems) · Dependencias / Impactos (5 bullets, en ese orden)
- `template-hist-usuario` — Descripción (Como / Quiero / Para) · Notas / Observaciones (7
  bullets) · Criterios de Aceptación · BDD (3 escenarios mínimo) · Prototipo (4 campos)

Ambas usan headings setext (subrayados con `---`) y `* * *` como separador entre secciones.
El formato de los títulos y de los IDs no lo decidas solo: preguntá, porque cambia todas las
tarjetas a la vez.

**Escribí un validador antes de subir nada.** Un script que chequee secciones, separadores y
cantidad de ítems contra la plantilla encuentra en segundos lo que a ojo se pasa por alto, y
sirve para revalidar releyendo desde Taiga después de escribir.

## Tools

Lectura: `taiga_diagnostics`, `taiga_capabilities`, `taiga_projects_list/get`,
`taiga_epics_list/get`, `taiga_stories_list/get`, `taiga_tasks_list/get`, `taiga_issues_get`,
`taiga_users_list`, `taiga_milestones_list`.

Escritura: `taiga_epics_create/update`, `taiga_stories_create/update`, `taiga_tasks_create/update`,
`taiga_issues_create/update`, `taiga_epics_add_user_story`, y los
`*_archive_or_close` como alternativa segura al borrado.

Los `update` son parciales: lo que no mandás no se toca. Traen `append_description` y `add_tags`
para sumar sin pisar, e `idempotency_key` en `tasks_create` para no duplicar al reintentar.
