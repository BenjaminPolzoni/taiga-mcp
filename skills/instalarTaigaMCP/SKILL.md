---
name: instalarTaigaMCP
description: Instalar y configurar el Taiga MCP del Grupo 10 en una máquina nueva con un solo comando npx. Usar cuando alguien del equipo tenga que dejar Taiga funcionando por primera vez, cuando los tools mcp__taiga__* no existan o den ConnectionRefused, cuando haya que cambiar de cuenta de Taiga, o cuando se nombre "instalar taiga", "configurar el MCP", "levantar taiga" o "/instalarTaigaMCP".
---

# Instalar el Taiga MCP

Un solo comando deja el servidor corriendo y registrado:

```bash
npx -y --allow-git=root github:BenjaminPolzoni/taiga-mcp
```

Pide las credenciales de Taiga la primera vez, levanta el servidor en Docker y lo
registra en Claude Code. **No hace falta tener Python**: todo corre adentro del contenedor.

Si la sesión de Claude Code ya estaba abierta cuando terminó, reconectá con `/mcp` para que
aparezcan los tools.

## Qué necesita la máquina

| | Para qué | Si falta |
|---|---|---|
| **Docker Desktop** | Corre el servidor | [docker.com](https://www.docker.com/products/docker-desktop/). Tiene que estar **abierto**, no solo instalado |
| **Node 18+** | Ejecuta el comando `npx` | [nodejs.org](https://nodejs.org) |
| **Cuenta de Taiga** | Leer y escribir el backlog | Pedir el alta en el proyecto a quien lo administra |

Python no hace falta. Git tampoco: `npx` baja el código solo.

## Credenciales

Cada persona usa **su propia cuenta de Taiga** y tiene que ser miembro del proyecto. El
comando valida usuario y contraseña contra Taiga antes de guardar nada, así que un typo se
detecta ahí y no más tarde con un error raro.

Se guardan en `~/.taiga-mcp/.env`, fuera del repo. Ese archivo **no se comparte ni se sube a
ningún lado**: quien lo tenga puede escribir en el backlog con tu nombre. Si alguien pide las
credenciales por chat, la respuesta es que corra el comando con su cuenta.

Para cambiar de cuenta:

```bash
npx -y --allow-git=root github:BenjaminPolzoni/taiga-mcp --reconfigure
```

El perfil queda en `ide` con `TAIGA_DESTRUCTIVE_MODE=off`, o sea **sin tools de borrado**. Es a
propósito: borrar una épica o una historia se lleva puesto el `ref` que otros grupos citan. Si
hace falta borrar algo, se habla antes; no se cambia el flag por cuenta propia.

## Uso diario

El contenedor se reinicia solo con Docker (`restart: unless-stopped`), así que normalmente no
hay que hacer nada. Cuando sí:

```bash
docker start taiga-mcp     # volver a levantarlo
docker stop taiga-mcp      # apagarlo
docker logs taiga-mcp --tail 30
curl http://localhost:8010/healthz     # responde: ok
```

Para actualizar a la última versión del repo, volvé a correr el `npx`: reconstruye la imagen
desde el código nuevo y reemplaza el contenedor. Las credenciales no se vuelven a pedir.

## Cuando algo falla

Diagnosticá en este orden; el 90% de las veces es lo primero.

**0. ¿npm rechaza el comando?** `npm error code EALLOWGIT · Fetching packages of type "git"
have been disabled`. npm 12 bloquea los paquetes de git por defecto; por eso el comando lleva
`--allow-git=root`. Si lo copiaste sin el flag, agregalo. En npm anterior a 12 el flag se
ignora sin romper nada.

**1. ¿Docker está abierto?** El error es `Docker está instalado pero el daemon no responde`.
Abrí Docker Desktop, esperá el «Engine running» y repetí el comando. Este es el caso más
común de lejos: Docker no arranca solo al prender la máquina.

**2. ¿El servidor responde?** `curl http://localhost:8010/healthz` tiene que devolver `ok`.
Si no, `docker start taiga-mcp` y, si sigue, `docker logs taiga-mcp --tail 30`.

**3. ¿El cliente está conectado?** Si el servidor responde pero no ves los tools
`mcp__taiga__*`, el cliente no reconectó: usá `/mcp` en Claude Code. Levantar el servidor
después de abrir la sesión siempre deja los tools ausentes hasta reconectar.

**4. ¿Choca el nombre del contenedor?** `Conflict. The container name "/taiga-mcp" is already
in use`. El lanzador ya lo resuelve solo; a mano es `docker rm -f taiga-mcp`. No tiene estado:
todo vive en Taiga, no en el contenedor.

**5. ¿El puerto 8010 está ocupado?** Pasa si alguien levantó el servidor a mano con `uvicorn`
además del contenedor. Cerrá ese proceso: con dos cosas escuchando no hay forma de saber cuál
contesta.

**6. ¿Taiga se cayó?** `api.taiga.io` devuelve 503 bastante seguido. Se ve como errores de tool
sin mensaje o timeouts. No es tu instalación: esperá y reintentá.

## Para trabajar con el backlog

Una vez instalado, la skill **mcpTaiga** cubre el uso: modelo de épicas/historias/tareas, las
trampas de la API y las plantillas de la wiki que la cátedra califica. Esta skill es solo el
arranque.
