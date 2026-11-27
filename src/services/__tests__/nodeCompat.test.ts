import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  formatUnsupportedNodeMessage,
  isSupportedNodeVersion,
  parseNodeVersion,
  SUPPORTED_NODE_RANGE,
} from '../../../scripts/node-compat.mjs';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const NODE_COMPAT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'node-compat.mjs');

describe('Centralized Node.js compatibility helper (BL-03: scripts/node-compat.mjs)', () => {
  it('validates the exact supported engines.node range (^22.12.0 || ^24.0.0 || >=26.0.0)', () => {
    expect(SUPPORTED_NODE_RANGE).toBe('^22.12.0 || ^24.0.0 || >=26.0.0');

    expect(parseNodeVersion('v24.11.0')).toEqual({ major: 24, minor: 11, patch: 0 });
    expect(parseNodeVersion('invalid')).toBeNull();

    // Supported versions
    expect(isSupportedNodeVersion('22.12.0')).toBe(true);
    expect(isSupportedNodeVersion('v22.14.0')).toBe(true);
    expect(isSupportedNodeVersion('24.0.0')).toBe(true);
    expect(isSupportedNodeVersion('v24.11.0')).toBe(true);
    expect(isSupportedNodeVersion('26.0.0')).toBe(true);
    expect(isSupportedNodeVersion('27.1.0')).toBe(true);

    // Unsupported versions (including pre-releases rejected by engines.node)
    expect(isSupportedNodeVersion('20.18.1')).toBe(false);
    expect(isSupportedNodeVersion('22.11.9')).toBe(false);
    expect(isSupportedNodeVersion('22.12.0-rc.1')).toBe(false);
    expect(isSupportedNodeVersion('23.9.0')).toBe(false);
    expect(isSupportedNodeVersion('24.0.0-alpha.1')).toBe(false);
    expect(isSupportedNodeVersion('24.11.0-beta.2')).toBe(false);
    expect(isSupportedNodeVersion('25.0.0')).toBe(false);
    expect(isSupportedNodeVersion('26.0.0-nightly')).toBe(false);
    expect(isSupportedNodeVersion('')).toBe(false);
    expect(isSupportedNodeVersion('invalid')).toBe(false);
    expect(parseNodeVersion('24.0.0-alpha.1')).toBeNull();
  });

  it('produces actionable pt-BR diagnostics and supports CLI --is-supported / --check', () => {
    const msg = formatUnsupportedNodeMessage('20.18.1', 'test');
    expect(msg).toContain('v20.18.1');
    expect(msg).toContain('para executar "test"');
    expect(msg).toContain(SUPPORTED_NODE_RANGE);
    expect(msg).toContain('Node 24 LTS');

    // Positive CLI check using current Node runtime (when supported)
    if (isSupportedNodeVersion(process.versions.node)) {
      execFileSync(process.execPath, [NODE_COMPAT_SCRIPT, '--check', 'test'], {
        stdio: 'pipe',
        windowsHide: true,
      });
    }

    // --is-supported returns 0 for supported and non-zero for unsupported
    execFileSync(process.execPath, [NODE_COMPAT_SCRIPT, '--is-supported', '24.11.0'], {
      stdio: 'pipe',
      windowsHide: true,
    });

    let rejected = false;
    try {
      execFileSync(process.execPath, [NODE_COMPAT_SCRIPT, '--is-supported', '20.18.1'], {
        stdio: 'pipe',
        windowsHide: true,
      });
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});
