import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SUPPORTED_NODE_RANGE = '^22.12.0 || ^24.0.0 || >=26.0.0';

export function parseNodeVersion(versionString = process.versions.node) {
  const match = String(versionString)
    .trim()
    .replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function isSupportedNodeVersion(versionString = process.versions.node) {
  const parsed = parseNodeVersion(versionString);
  if (!parsed) return false;
  if (parsed.major === 22) return parsed.minor >= 12;
  if (parsed.major === 24) return true;
  return parsed.major >= 26;
}

export function formatUnsupportedNodeMessage(
  versionString = process.versions.node,
  commandLabel = '',
) {
  const normalized = String(versionString || 'desconhecida').trim();
  const displayVersion = normalized.startsWith('v')
    ? normalized
    : `v${normalized}`;
  const context = commandLabel ? ` para executar "${commandLabel}"` : '';
  return [
    `[Vértice Workspace] Node.js incompatível${context}: encontrado ${displayVersion} (${process.execPath}).`,
    `Faixa suportada (package.json#engines.node): ${SUPPORTED_NODE_RANGE} (recomendado: Node 24 LTS).`,
    'Ative um runtime compatível apenas nesta sessão ou instale o Node 24 LTS (https://nodejs.org/) antes de prosseguir.',
    'Exemplo no PowerShell (sem alterar variáveis globais): $env:PATH = "<pasta-do-node-24>;$env:PATH"',
  ].join('\n');
}

export function assertSupportedNodeVersion(commandLabel = '') {
  if (!isSupportedNodeVersion(process.versions.node)) {
    process.stderr.write(`${formatUnsupportedNodeMessage(process.versions.node, commandLabel)}\n`);
    process.exit(1);
  }
}

const isEntrypoint =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  const args = process.argv.slice(2);
  if (args[0] === '--is-supported') {
    const candidate = args[1] ?? process.versions.node;
    process.exit(isSupportedNodeVersion(candidate) ? 0 : 1);
  }
  const commandLabel =
    args[0] === '--check' ? (args[1] ?? '') : (args[0] ?? '');
  assertSupportedNodeVersion(commandLabel);
}
