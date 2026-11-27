import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertSupportedNodeVersion,
  isSupportedNodeVersion,
  SUPPORTED_NODE_RANGE,
} from './node-compat.mjs';
import { isLoopbackHost, loadEnvFiles } from './vertice-server.mjs';

export { isSupportedNodeVersion };

const SCRIPT_MARKER = 'scripts/vertice-server.mjs';
const CONTROL_IDENTITY_PATH = '/__vertice_ctl/identity';
const CONTROL_SHUTDOWN_PATH = '/__vertice_ctl/shutdown';
const CONTROL_TOKEN_HEADER = 'x-vertice-control-token';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRootDir = path.resolve(scriptDir, '..');

export function restrictPrivateFileAcl(filePath) {
  if (process.platform !== 'win32') {
    return { applied: true, platform: process.platform };
  }
  try {
    const username = os.userInfo().username;
    const domain = String(process.env.USERDOMAIN || '').trim();
    const principal = domain ? `${domain}\\${username}` : username;
    execFileSync(
      'icacls',
      [filePath, '/inheritance:r', '/grant:r', `${principal}:F`],
      { windowsHide: true, stdio: 'ignore' },
    );
    return { applied: true, platform: 'win32', principal };
  } catch (err) {
    return {
      applied: false,
      platform: 'win32',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

function getPaths(rootDir = defaultRootDir) {
  const stateDir = path.join(rootDir, '.vertice');
  const logsDir = path.join(stateDir, 'logs');
  const pidFile = path.join(stateDir, 'server.json');
  return { rootDir, stateDir, logsDir, pidFile };
}

function computeServerScriptFingerprint(rootDir = defaultRootDir) {
  const hash = crypto.createHash('sha256');
  for (const rel of [
    path.join('scripts', 'node-compat.mjs'),
    path.join('scripts', 'vertice-server.mjs'),
    path.join('scripts', 'vertice-source-reader.mjs'),
    path.join('scripts', 'vertice-folder-picker.mjs'),
    path.join('scripts', 'vertice-workspace-diff.mjs'),
  ]) {
    const abs = path.join(rootDir, rel);
    hash.update(rel);
    if (fs.existsSync(abs)) {
      hash.update(fs.readFileSync(abs));
    }
  }
  return hash.digest('hex').slice(0, 16);
}

function formatOrigin(host, port) {
  const hostPart =
    host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${hostPart}:${port}`;
}

function parseTrackedServerFile(pidFile) {
  if (!fs.existsSync(pidFile)) {
    return { ok: false, kind: 'absent' };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  } catch {
    return {
      ok: false,
      kind: 'invalid',
      reason: 'arquivo .vertice/server.json contém JSON inválido',
    };
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof parsed.pid !== 'number' ||
    !Number.isInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    parsed.script !== SCRIPT_MARKER ||
    typeof parsed.host !== 'string' ||
    !parsed.host.trim() ||
    typeof parsed.port !== 'number' ||
    !Number.isInteger(parsed.port) ||
    parsed.port <= 0 ||
    parsed.port > 65535 ||
    typeof parsed.origin !== 'string' ||
    !parsed.origin.trim() ||
    typeof parsed.instanceId !== 'string' ||
    !parsed.instanceId.trim() ||
    typeof parsed.controlToken !== 'string' ||
    !parsed.controlToken.trim() ||
    typeof parsed.startedAt !== 'string' ||
    !parsed.startedAt.trim()
  ) {
    return {
      ok: false,
      kind: 'invalid',
      reason:
        'metadados incompletos ou formato legado sem instanceId/controlToken comprováveis',
    };
  }

  return { ok: true, tracked: parsed };
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function verifyTrackedIdentity(tracked, timeoutMs = 1500) {
  try {
    const res = await fetch(`${tracked.origin}${CONTROL_IDENTITY_PATH}`, {
      method: 'GET',
      headers: {
        [CONTROL_TOKEN_HEADER]: tracked.controlToken,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return {
        verified: false,
        reason: `endpoint de controle respondeu HTTP ${res.status}`,
      };
    }
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') {
      return {
        verified: false,
        reason: 'resposta de identidade não é JSON válido',
      };
    }
    if (
      data.ok !== true ||
      data.service !== 'vertice-server' ||
      data.instanceId !== tracked.instanceId ||
      data.pid !== tracked.pid
    ) {
      return {
        verified: false,
        reason:
          'identidade retornada (service/instanceId/pid) não corresponde ao registro salvo',
      };
    }
    return { verified: true, identity: data };
  } catch (err) {
    return {
      verified: false,
      reason:
        err instanceof Error
          ? `falha ao consultar controle autenticado (${err.message})`
          : 'falha ao consultar controle autenticado',
    };
  }
}

export async function inspectTrackedServer(rootDir = defaultRootDir) {
  const { pidFile } = getPaths(rootDir);
  const parsed = parseTrackedServerFile(pidFile);
  if (!parsed.ok) {
    return {
      status: parsed.kind,
      reason: parsed.reason,
      pidFile,
    };
  }

  const { tracked } = parsed;
  if (!isPidAlive(tracked.pid)) {
    return {
      status: 'dead',
      tracked,
      pidFile,
    };
  }

  const check = await verifyTrackedIdentity(tracked);
  if (!check.verified) {
    return {
      status: 'unverified_pid',
      tracked,
      reason: check.reason,
      pidFile,
    };
  }

  return {
    status: 'verified_active',
    tracked,
    identity: check.identity,
    pidFile,
  };
}

function checkPortInUse(host, port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => {
      resolve(true);
    });
    tester.listen(port, host, () => {
      tester.close(() => resolve(false));
    });
  });
}

function getRuntimeConfig(rootDir = defaultRootDir) {
  const fileEnv = loadEnvFiles(rootDir);
  const host = String(
    process.env.VERTICE_HOST ??
    process.env.HOST ??
    fileEnv.VERTICE_HOST ??
    fileEnv.HOST ??
    '127.0.0.1',
  ).trim();
  const port = Number(
    process.env.VERTICE_PORT ??
    process.env.PORT ??
    fileEnv.VERTICE_PORT ??
    fileEnv.PORT ??
    4173,
  );
  const proxyTarget = String(
    process.env.VITE_AIONCORE_PROXY_TARGET ??
    fileEnv.VITE_AIONCORE_PROXY_TARGET ??
    '',
  ).trim();
  const baseUrlEnv = String(
    process.env.VITE_AIONCORE_BASE_URL ??
    fileEnv.VITE_AIONCORE_BASE_URL ??
    '',
  ).trim();
  return { host, port, proxyTarget, baseUrlEnv };
}

async function cmdDoctor(rootDir = defaultRootDir) {
  const { host, port, proxyTarget, baseUrlEnv } = getRuntimeConfig(rootDir);
  const { stateDir, logsDir, pidFile } = getPaths(rootDir);
  const nodeSupported = isSupportedNodeVersion(process.versions.node);
  const distDir = path.join(rootDir, 'dist');
  const distIndex = path.join(distDir, 'index.html');
  const distBuilt = fs.existsSync(distIndex);
  const envLocalExists = fs.existsSync(path.join(rootDir, '.env.local'));
  const portValid = Number.isInteger(port) && port >= 1 && port <= 65535;
  const hostLoopback = isLoopbackHost(host);
  const inspection = await inspectTrackedServer(rootDir);
  const portOccupied = portValid ? await checkPortInUse(host, port) : false;

  const recoverySteps = [];

  if (!nodeSupported) {
    recoverySteps.push(
      `Node.js fora da faixa suportada: instale ou ative Node ${SUPPORTED_NODE_RANGE} (recomendado 24.x LTS) antes de executar build ou servidor.`,
    );
  }
  if (!distBuilt) {
    recoverySteps.push(
      'Build estático ausente: execute "npm run build" no diretório raiz antes de rodar "npm run server:start" ou "npm start".',
    );
  }
  if (!hostLoopback && process.env.ALLOW_NON_LOOPBACK !== 'true') {
    recoverySteps.push(
      `Host "${host}" não é loopback: ajuste VERTICE_HOST="127.0.0.1" no .env.local (loopback obrigatório por padrão na v1).`,
    );
  }
  if (!portValid) {
    recoverySteps.push(
      `Porta configurada inválida (${port}): defina VERTICE_PORT inteiro entre 1 e 65535 no .env.local (padrão: 4173).`,
    );
  }

  let proxyTargetValid = true;
  let proxyLoopback = true;
  let coreHealth = 'não configurado (VITE_AIONCORE_PROXY_TARGET vazio)';
  if (proxyTarget) {
    let parsedTarget = null;
    try {
      parsedTarget = new URL(proxyTarget);
      if (parsedTarget.protocol !== 'http:' && parsedTarget.protocol !== 'https:') {
        throw new Error(`esquema "${parsedTarget.protocol}" não suportado`);
      }
      proxyLoopback = isLoopbackHost(parsedTarget.hostname);
    } catch {
      proxyTargetValid = false;
      coreHealth = `URL inválida em VITE_AIONCORE_PROXY_TARGET ("${proxyTarget}")`;
      recoverySteps.push(
        'Corrija VITE_AIONCORE_PROXY_TARGET em .env.local usando URL HTTP(S) completa, ex.: "http://127.0.0.1:25828".',
      );
    }

    if (parsedTarget && proxyTargetValid) {
      const targetUrl = new URL('/health', parsedTarget).toString();
      try {
        const res = await fetch(targetUrl, { signal: AbortSignal.timeout(1500) });
        coreHealth = res.ok
          ? `alcançável (HTTP ${res.status} em ${targetUrl})`
          : `respondeu HTTP ${res.status} em ${targetUrl}`;
        if (!res.ok) {
          recoverySteps.push(
            `AionCore respondeu HTTP ${res.status} em ${targetUrl}: verifique logs do Core (--log-dir externo) e reinicie o serviço AionCore separado.`,
          );
        }
      } catch (err) {
        const errCode =
          err && typeof err === 'object' && 'cause' in err && err.cause && typeof err.cause === 'object' && 'code' in err.cause
            ? String(err.cause.code)
            : '';
        const detail = errCode || (err instanceof Error ? err.message : 'erro de rede');
        coreHealth = `inacessível (${detail})`;
        recoverySteps.push(
          `AionCore inacessível em ${proxyTarget}: inicie o binário externo AionCore (--identity-mode webui --host 127.0.0.1 --port <PORTA>) ou confira a porta em .env.local.`,
        );
      }
    }
  } else {
    recoverySteps.push(
      'Para operar em Modo AionCore local via proxy de mesma origem, copie .env.example para .env.local e preencha VITE_AIONCORE_PROXY_TARGET="http://127.0.0.1:<PORTA_DO_CORE>" (opcional para Modo Demonstração).',
    );
  }

  if (baseUrlEnv && proxyTarget) {
    recoverySteps.push(
      `VITE_AIONCORE_BASE_URL está definido como "${baseUrlEnv}": deixe vazio ("") para utilizar o proxy na mesma origem e preservar cookies HttpOnly/CSRF.`,
    );
  }
  if (proxyTargetValid && proxyTarget && !proxyLoopback) {
    recoverySteps.push(
      `VITE_AIONCORE_PROXY_TARGET aponta para host não-loopback (${proxyTarget}): na v1 local recomenda-se manter Core e servidor Vértice apenas em 127.0.0.1.`,
    );
  }

  let instanceSummary = 'parado (nenhuma instância registrada)';
  if (inspection.status === 'verified_active') {
    instanceSummary = `ativo e verificado em ${inspection.tracked.origin} (PID ${inspection.tracked.pid}, instância ${inspection.tracked.instanceId})`;
  } else if (inspection.status === 'unverified_pid') {
    instanceSummary = `NÃO comprovado — PID ${inspection.tracked.pid} está vivo no sistema, mas não foi reconhecido como servidor Vértice autenticado (${inspection.reason})`;
    recoverySteps.push(
      `PID ${inspection.tracked.pid} em ${pidFile} está vivo mas não respondeu ao token de controle: o launcher NÃO encerrará esse PID alheio. Verifique os processos do SO e, confirmando que não há vertice-server antigo ativo, remova manualmente ${pidFile} ou configure outra VERTICE_PORT livre.`,
    );
  } else if (inspection.status === 'dead') {
    instanceSummary = `parado (registro obsoleto para PID morto ${inspection.tracked.pid})`;
    recoverySteps.push(
      `Registro obsoleto detectado em ${pidFile} (PID ${inspection.tracked.pid} inativo): ele será limpo automaticamente no próximo "server:status", "server:stop" ou "server:start".`,
    );
  } else if (inspection.status === 'invalid') {
    instanceSummary = `registro inválido ou legado sem identidade comprovável (${inspection.reason})`;
    recoverySteps.push(
      `Registro inválido/legado em ${pidFile}: nenhum processo foi encerrado automaticamente. Confirme que não há processo antigo na porta e remova ${pidFile} antes de iniciar.`,
    );
  }

  const verifiedOwnsConfiguredPort =
    inspection.status === 'verified_active' &&
    inspection.tracked.host === host &&
    inspection.tracked.port === port;

  if (portValid && portOccupied && !verifiedOwnsConfiguredPort) {
    recoverySteps.push(
      `Porta ${port} em ${host} ocupada por processo externo não comprovado como instância deste launcher: encerre o serviço externo nessa porta ou ajuste VERTICE_PORT no .env.local.`,
    );
  }

  console.log('=== Diagnóstico Vértice Workspace (distribuição local) ===');
  console.log(
    `- Node.js: ${process.version} (${nodeSupported ? `compatível com ${SUPPORTED_NODE_RANGE}` : `incompatível: exige ${SUPPORTED_NODE_RANGE}`})`,
  );
  console.log(
    `- Build estático (dist/index.html): ${distBuilt ? 'encontrado' : 'ausente (execute npm run build)'}`,
  );
  console.log(
    `- Arquivo .env.local: ${envLocalExists ? 'presente' : 'ausente (opcional para Modo Demonstração)'}`,
  );
  console.log(
    `- Endereço de escuta: ${host}:${portValid ? port : 'INVÁLIDO'} (${hostLoopback ? 'loopback seguro' : 'NÃO loopback — bloqueado por padrão'})`,
  );
  console.log(
    `- Proxy AionCore: ${proxyTarget || '(não definido)'} · /health: ${coreHealth}`,
  );
  if (baseUrlEnv) {
    console.log(`- VITE_AIONCORE_BASE_URL: ${baseUrlEnv} (aviso: prefira "" com proxy mesma origem)`);
  }
  console.log(`- Instância registrada: ${instanceSummary}`);
  console.log(
    `- Porta ${portValid ? port : '(inválida)'}: ${!portValid
      ? 'inválida (não verificada)'
      : portOccupied
        ? verifiedOwnsConfiguredPort
          ? `em uso pela instância verificada do Vértice (PID ${inspection.tracked.pid})`
          : 'ocupada por outro processo não comprovado como instância deste launcher'
        : 'livre'
    }`,
  );
  console.log(
    `- Separação de diretórios: código/build=${distDir} · controle/logs-web=${stateDir} (${logsDir}) · dados-UI=IndexedDB (navegador) · dados/logs Core=externos (--data-dir/--log-dir)`,
  );
  console.log('=== Ações e recuperação ===');
  if (recoverySteps.length === 0) {
    console.log('- Tudo pronto para iniciar com "npm run server:start" (ou já ativo e validado).');
  } else {
    for (const step of recoverySteps) {
      console.log(`- ${step}`);
    }
  }
}

async function cmdStart(rootDir = defaultRootDir) {
  assertSupportedNodeVersion('server:start');
  const { host, port } = getRuntimeConfig(rootDir);
  const { stateDir, logsDir, pidFile } = getPaths(rootDir);
  const distIndex = path.join(rootDir, 'dist', 'index.html');

  if (!fs.existsSync(distIndex)) {
    console.error(
      'Erro: dist/index.html não encontrado. Execute "npm run build" antes de iniciar.',
    );
    process.exit(1);
  }
  if (!isLoopbackHost(host) && process.env.ALLOW_NON_LOOPBACK !== 'true') {
    console.error(
      `Erro: host "${host}" não é loopback. Use 127.0.0.1, localhost ou ::1.`,
    );
    process.exit(1);
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`Erro: porta "${port}" inválida. Informe inteiro entre 1 e 65535.`);
    process.exit(1);
  }

  const currentFingerprint = computeServerScriptFingerprint(rootDir);
  const inspection = await inspectTrackedServer(rootDir);
  if (inspection.status === 'verified_active') {
    const { tracked } = inspection;
    if (tracked.host === host && tracked.port === port) {
      if (tracked.scriptFingerprint === currentFingerprint) {
        console.log(
          `Servidor já está em execução e verificado (PID ${tracked.pid}, instância ${tracked.instanceId}) em ${tracked.origin}.`,
        );
        return;
      }
      console.log(
        `Instância ativa (PID ${tracked.pid}) usa versão anterior do servidor; reiniciando com os scripts atuais...`,
      );
      await cmdStop(rootDir);
    } else {
      console.error(
        `Erro: outra instância verificada já está ativa em ${tracked.origin} (PID ${tracked.pid}). Encerre-a antes de iniciar em ${formatOrigin(host, port)}.`,
      );
      process.exit(1);
    }
  }

  if (await checkPortInUse(host, port)) {
    console.error(
      `Erro: porta ${port} em ${host} já está ocupada por outro processo não comprovado por este launcher. Nenhum processo alheio será encerrado.`,
    );
    process.exit(1);
  }

  if (inspection.status === 'dead') {
    fs.rmSync(pidFile, { force: true });
  } else if (inspection.status === 'unverified_pid') {
    console.warn(
      `Aviso: registro anterior apontava para PID ${inspection.tracked.pid} vivo, porém não comprovado como Vértice (${inspection.reason}). Esse processo alheio não foi tocado; o registro obsoleto será substituído.`,
    );
  } else if (inspection.status === 'invalid') {
    console.warn(
      `Aviso: registro anterior inválido será substituído (${inspection.reason}).`,
    );
  }

  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const outLogPath = path.join(logsDir, 'server.out.log');
  const errLogPath = path.join(logsDir, 'server.err.log');
  const outFd = fs.openSync(outLogPath, 'a');
  const errFd = fs.openSync(errLogPath, 'a');

  const instanceId = crypto.randomUUID();
  const controlToken = crypto.randomBytes(32).toString('hex');
  const startedAt = new Date().toISOString();
  const origin = formatOrigin(host, port);

  const serverScript = path.join(scriptDir, 'vertice-server.mjs');
  const child = spawn(process.execPath, [serverScript], {
    cwd: rootDir,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', outFd, errFd],
    env: {
      ...process.env,
      VERTICE_HOST: host,
      VERTICE_PORT: String(port),
      HOST: host,
      PORT: String(port),
      VERTICE_INSTANCE_ID: instanceId,
      VERTICE_CONTROL_TOKEN: controlToken,
      VERTICE_STARTED_AT: startedAt,
    },
  });

  child.unref();
  fs.closeSync(outFd);
  fs.closeSync(errFd);

  const expectedMetadata = {
    schemaVersion: 2,
    pid: child.pid,
    host,
    port,
    origin,
    instanceId,
    controlToken,
    startedAt,
    script: SCRIPT_MARKER,
    scriptFingerprint: currentFingerprint,
  };

  let ready = false;
  for (let i = 0; i < 30; i += 1) {
    if (!child.pid || !isPidAlive(child.pid)) break;
    const identityCheck = await verifyTrackedIdentity(expectedMetadata, 500);
    if (identityCheck.verified) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  if (!ready) {
    console.error(
      `Erro: processo PID ${child.pid ?? 'desconhecido'} não confirmou identidade em ${origin}. Consulte ${errLogPath}.`,
    );
    if (child.pid && isPidAlive(child.pid)) {
      try {
        process.kill(child.pid, 'SIGTERM');
      } catch {
        // Best effort cleanup of our own newly spawned process
      }
    }
    process.exit(1);
  }

  fs.writeFileSync(pidFile, JSON.stringify(expectedMetadata, null, 2), {
    mode: 0o600,
  });
  restrictPrivateFileAcl(pidFile);
  console.log(
    `Servidor iniciado e verificado em ${origin} (PID rastreado: ${child.pid}, instância: ${instanceId}).`,
  );
}

async function cmdStatus(rootDir = defaultRootDir) {
  const inspection = await inspectTrackedServer(rootDir);
  if (inspection.status === 'absent') {
    console.log('Servidor Vértice Workspace: parado (sem PID rastreado).');
    return;
  }
  if (inspection.status === 'dead') {
    fs.rmSync(inspection.pidFile, { force: true });
    console.log(
      `Servidor Vértice Workspace: parado (PID anterior ${inspection.tracked.pid} não está mais ativo; registro limpo).`,
    );
    return;
  }
  if (inspection.status === 'invalid') {
    console.log(
      `Servidor Vértice Workspace: não verificado (registro inválido ou legado sem identidade comprovável: ${inspection.reason}).`,
    );
    return;
  }
  if (inspection.status === 'unverified_pid') {
    console.log(
      `Servidor Vértice Workspace: não verificado (PID ${inspection.tracked.pid} está vivo no sistema, mas não comprovou ser a instância registrada: ${inspection.reason}).`,
    );
    return;
  }

  const { tracked } = inspection;
  console.log(
    `Servidor Vértice Workspace: ativo e verificado em ${tracked.origin} (PID ${tracked.pid}, instância ${tracked.instanceId}, desde ${tracked.startedAt}).`,
  );
}

async function cmdStop(rootDir = defaultRootDir) {
  const inspection = await inspectTrackedServer(rootDir);
  if (inspection.status === 'absent') {
    console.log('Nenhum servidor rastreado pelo launcher para encerrar.');
    return;
  }
  if (inspection.status === 'dead') {
    fs.rmSync(inspection.pidFile, { force: true });
    console.log(
      `Processo rastreado (PID ${inspection.tracked.pid}) já estava encerrado; registro removido.`,
    );
    return;
  }
  if (inspection.status === 'invalid') {
    console.error(
      `Recusado: registro em .vertice/server.json é inválido ou não possui identidade verificável (${inspection.reason}). Nenhum processo foi encerrado.`,
    );
    process.exit(1);
  }
  if (inspection.status === 'unverified_pid') {
    console.error(
      `Recusado: PID ${inspection.tracked.pid} existe no sistema, mas não comprovou ser a instância registrada do Vértice (${inspection.reason}). Nenhum processo alheio foi encerrado.`,
    );
    process.exit(1);
  }

  const { tracked, pidFile } = inspection;

  // 1. Authenticated graceful shutdown via control endpoint
  try {
    await fetch(`${tracked.origin}${CONTROL_SHUTDOWN_PATH}`, {
      method: 'POST',
      headers: {
        [CONTROL_TOKEN_HEADER]: tracked.controlToken,
      },
      signal: AbortSignal.timeout(1500),
    });
  } catch {
    // Fallback check below before any signal
  }

  for (let i = 0; i < 25; i += 1) {
    if (!isPidAlive(tracked.pid)) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  // 2. Only send SIGTERM if PID is STILL verified as our own instance
  if (isPidAlive(tracked.pid)) {
    const stillVerified = await verifyTrackedIdentity(tracked, 1000);
    if (!stillVerified.verified) {
      console.error(
        `Recusado: PID ${tracked.pid} não respondeu ao controle autenticado após tentativa de encerramento (${stillVerified.reason}). Nenhum sinal de término foi enviado.`,
      );
      process.exit(1);
    }
    process.kill(tracked.pid, 'SIGTERM');
    for (let i = 0; i < 15; i += 1) {
      if (!isPidAlive(tracked.pid)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  if (isPidAlive(tracked.pid)) {
    console.error(
      `Aviso: PID ${tracked.pid} ainda não finalizou após encerramento controlado.`,
    );
    process.exit(1);
  }

  fs.rmSync(pidFile, { force: true });
  console.log(
    `Servidor encerrado com segurança (PID ${tracked.pid}, instância ${tracked.instanceId}).`,
  );
}

const isEntrypoint =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  const command = process.argv[2] ?? 'status';
  switch (command) {
    case 'doctor':
      await cmdDoctor();
      break;
    case 'start':
      await cmdStart();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'stop':
      await cmdStop();
      break;
    default:
      console.error('Uso: node scripts/vertice-ctl.mjs <doctor|start|status|stop>');
      process.exit(1);
  }
}
