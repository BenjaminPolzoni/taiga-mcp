#!/usr/bin/env node
/**
 * Lanzador del Taiga MCP.
 *
 *   npx github:BenjaminPolzoni/taiga-mcp
 *
 * Pide las credenciales de Taiga la primera vez, levanta el servidor en Docker
 * y lo deja registrado en Claude Code. Sin Python: todo corre en el contenedor.
 */
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const RAIZ = path.resolve(__dirname, "..");
// npx descarga el paquete a una cache efimera: las credenciales viven en el home
const HOME_DATOS = path.join(os.homedir(), ".taiga-mcp");
const ENV_PERSISTENTE = path.join(HOME_DATOS, ".env");
const ENV_PAQUETE = path.join(RAIZ, ".env");
const PUERTO = 8010;
const URL_MCP = `http://localhost:${PUERTO}/mcp/`;
const URL_SALUD = `http://localhost:${PUERTO}/healthz`;

const args = new Set(process.argv.slice(2));
const RECONFIGURAR = args.has("--reconfigure");
const SIN_REGISTRO = args.has("--no-register");

const c = {
  ok: (t) => `\x1b[32m${t}\x1b[0m`,
  mal: (t) => `\x1b[31m${t}\x1b[0m`,
  attn: (t) => `\x1b[33m${t}\x1b[0m`,
  tenue: (t) => `\x1b[90m${t}\x1b[0m`,
  fuerte: (t) => `\x1b[1m${t}\x1b[0m`,
};

const log = (t = "") => console.log(t);
const paso = (t) => log(`\n${c.fuerte(t)}`);
const bien = (t) => log(`  ${c.ok("✓")} ${t}`);
const aviso = (t) => log(`  ${c.attn("!")} ${t}`);

function morir(titulo, detalle) {
  log(`\n  ${c.mal("✗")} ${c.fuerte(titulo)}`);
  if (detalle) log(detalle.split("\n").map((l) => `    ${l}`).join("\n"));
  log();
  process.exit(1);
}

function correr(cmd, argv, opciones = {}) {
  return spawnSync(cmd, argv, { encoding: "utf8", shell: false, ...opciones });
}

const existe = (cmd) =>
  correr(process.platform === "win32" ? "where" : "which", [cmd]).status === 0;

// ---------------------------------------------------------------- 1. requisitos

function revisarDocker() {
  paso("1. Revisando Docker");
  if (!existe("docker")) {
    morir(
      "Docker no está instalado.",
      "Instalá Docker Desktop y volvé a correr este comando:\n" +
        "https://www.docker.com/products/docker-desktop/"
    );
  }
  const info = correr("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (info.status !== 0) {
    morir(
      "Docker está instalado pero el daemon no responde.",
      "Abrí Docker Desktop, esperá a que diga «Engine running» y repetí el comando."
    );
  }
  bien(`Docker ${info.stdout.trim()} respondiendo`);

  if (correr("docker", ["compose", "version"]).status !== 0) {
    morir(
      "Falta docker compose.",
      "Viene con Docker Desktop; si usás Docker Engine suelto, instalá el plugin compose."
    );
  }
  bien("docker compose disponible");
}

// ------------------------------------------------------------- 2. credenciales

function preguntar(rl, pregunta) {
  return new Promise((resolve) => rl.question(pregunta, (r) => resolve(r.trim())));
}

/** Lee sin mostrar lo tipeado: la contraseña no queda en pantalla ni en el scrollback. */
function preguntarOculto(rl, pregunta) {
  return new Promise((resolve) => {
    const alEscribir = (char) => {
      if (char.toString() === "\r" || char.toString() === "\n") return;
      rl.output.write("\x1b[2K\x1b[200D" + pregunta + "*".repeat(rl.line.length));
    };
    rl.input.on("data", alEscribir);
    rl.question(pregunta, (valor) => {
      rl.input.removeListener("data", alEscribir);
      rl.output.write("\n");
      resolve(valor.trim());
    });
  });
}

async function validarCredenciales(baseUrl, usuario, password) {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/v1/auth`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "normal", username: usuario, password }),
      signal: AbortSignal.timeout(20000),
    });
    if (r.ok) return { ok: true };
    if (r.status === 400 || r.status === 401) {
      return { ok: false, motivo: "Usuario o contraseña incorrectos." };
    }
    return { ok: false, motivo: `Taiga respondió ${r.status}.`, transitorio: r.status >= 500 };
  } catch (e) {
    return { ok: false, motivo: `No se pudo contactar a Taiga (${e.message}).`, transitorio: true };
  }
}

async function configurarCredenciales() {
  paso("2. Credenciales de Taiga");

  if (fs.existsSync(ENV_PERSISTENTE) && !RECONFIGURAR) {
    bien(`Usando las que ya tenías en ${c.tenue(ENV_PERSISTENTE)}`);
    return;
  }

  if (!process.stdin.isTTY) {
    morir(
      "Hacen falta credenciales y la consola no es interactiva.",
      `Creá ${ENV_PERSISTENTE} con TAIGA_BASE_URL, TAIGA_USERNAME y TAIGA_PASSWORD,\n` +
        "o volvé a correr el comando en una terminal interactiva."
    );
  }

  log("  Son tus credenciales de Taiga. Se guardan solo en tu máquina.");
  log(c.tenue("  Usá tu propia cuenta: no compartas una cuenta entre el equipo."));
  log();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const baseUrl =
      (await preguntar(rl, "  Instancia de Taiga [https://api.taiga.io]: ")) ||
      "https://api.taiga.io";

    for (let intento = 1; ; intento++) {
      const usuario = await preguntar(rl, "  Usuario de Taiga: ");
      const password = await preguntarOculto(rl, "  Contraseña: ");

      if (!usuario || !password) {
        aviso("Usuario y contraseña no pueden estar vacíos.");
        continue;
      }

      process.stdout.write("  Verificando contra Taiga... ");
      const r = await validarCredenciales(baseUrl, usuario, password);
      if (r.ok) {
        log(c.ok("ok"));
        guardarEnv(baseUrl, usuario, password);
        bien(`Guardadas en ${c.tenue(ENV_PERSISTENTE)}`);
        return;
      }

      log(c.mal("falló"));
      aviso(r.motivo);
      if (r.transitorio) {
        aviso("Parece un problema de Taiga, no tuyo. Probá de nuevo en un rato.");
      }
      if (intento >= 3) {
        morir("Tres intentos fallidos.", "Revisá tus credenciales y volvé a correr el comando.");
      }
    }
  } finally {
    rl.close();
  }
}

function guardarEnv(baseUrl, usuario, password) {
  fs.mkdirSync(HOME_DATOS, { recursive: true });
  const contenido =
    "# Generado por el lanzador de taiga-mcp. No lo subas a ningún repo.\n" +
    `TAIGA_BASE_URL=${baseUrl}\n` +
    `TAIGA_USERNAME=${usuario}\n` +
    `TAIGA_PASSWORD=${password}\n` +
    "\n# ide = desarrollo sin borrados. builder habilita borrar: cambialo a conciencia.\n" +
    "TAIGA_PROFILE=ide\n" +
    "TAIGA_DESTRUCTIVE_MODE=off\n";
  fs.writeFileSync(ENV_PERSISTENTE, contenido, { mode: 0o600 });
  try {
    fs.chmodSync(ENV_PERSISTENTE, 0o600); // en Windows es cosmetico, no molesta
  } catch {}
}

// ------------------------------------------------------------- 3. el contenedor

async function esperarSalud(segundos = 90) {
  const limite = Date.now() + segundos * 1000;
  while (Date.now() < limite) {
    try {
      const r = await fetch(URL_SALUD, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function levantar() {
  paso("3. Levantando el servidor");
  fs.copyFileSync(ENV_PERSISTENTE, ENV_PAQUETE); // compose lee .env junto al yml

  const nombreEnUso = correr("docker", [
    "ps", "-a", "--filter", "name=^taiga-mcp$", "--format", "{{.Names}}",
  ]).stdout.trim();
  if (nombreEnUso) {
    aviso("Ya había un contenedor taiga-mcp: lo reemplazo por el de esta versión.");
    correr("docker", ["rm", "-f", "taiga-mcp"]);
  }

  log(c.tenue("  Construyendo la imagen (la primera vez tarda unos minutos)..."));
  const up = correr("docker", ["compose", "up", "-d", "--build"], {
    cwd: RAIZ,
    stdio: ["ignore", "ignore", "pipe"],
  });
  if (up.status !== 0) {
    morir("No se pudo levantar el contenedor.", (up.stderr || "").trim().split("\n").slice(-12).join("\n"));
  }
  bien("Contenedor creado");

  process.stdout.write("  Esperando a que responda... ");
  if (!(await esperarSalud())) {
    log(c.mal("no respondió"));
    const logs = correr("docker", ["compose", "logs", "--tail", "25"], { cwd: RAIZ });
    morir(
      `El contenedor levantó pero ${URL_SALUD} no contesta.`,
      (logs.stdout || logs.stderr || "").trim()
    );
  }
  log(c.ok("ok"));
}

// -------------------------------------------------------------- 4. Claude Code

function registrar() {
  paso("4. Registrando el MCP en Claude Code");
  if (SIN_REGISTRO) {
    aviso("Omitido por --no-register.");
    return false;
  }
  if (!existe("claude")) {
    aviso("No encontré el comando claude: salteo el registro.");
    return false;
  }
  const yaEsta = correr("claude", ["mcp", "list"]).stdout || "";
  if (/^\s*taiga\b/m.test(yaEsta)) {
    bien("Ya estaba registrado como «taiga»");
    return true;
  }
  const alta = correr("claude", ["mcp", "add", "--transport", "http", "taiga", URL_MCP]);
  if (alta.status !== 0) {
    aviso("No pude registrarlo automáticamente; abajo te dejo la configuración.");
    return false;
  }
  bien("Registrado como «taiga»");
  return true;
}

// -------------------------------------------------------------------- cierre

function cierre(registrado) {
  log(`\n${c.ok("Listo.")} El Taiga MCP está corriendo en ${c.fuerte(URL_MCP)}\n`);
  if (registrado) {
    log("  Abrí Claude Code y pedile algo de Taiga. Si la sesión ya estaba abierta,");
    log("  reconectá con " + c.fuerte("/mcp") + " para que aparezcan los tools.");
  } else {
    log("  Agregá esto a la configuración MCP de tu cliente:\n");
    log(c.tenue(JSON.stringify({ mcpServers: { taiga: { type: "http", url: URL_MCP } } }, null, 2)
      .split("\n").map((l) => "    " + l).join("\n")));
  }
  log(`\n  ${c.tenue("Apagarlo:")}      docker stop taiga-mcp`);
  log(`  ${c.tenue("Volver a abrir:")} docker start taiga-mcp`);
  log(`  ${c.tenue("Cambiar cuenta:")} npx github:BenjaminPolzoni/taiga-mcp --reconfigure`);
  log();
}

(async () => {
  log(`\n${c.fuerte("Taiga MCP")} ${c.tenue("· lanzador")}`);
  revisarDocker();
  await configurarCredenciales();
  await levantar();
  cierre(registrar());
})().catch((e) => morir("Error inesperado.", e && e.stack ? e.stack : String(e)));
