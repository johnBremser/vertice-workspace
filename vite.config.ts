import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { handleLocalFolderRequest } from './scripts/vertice-folder-picker.mjs';
import { handleAssistantSourceRequest } from './scripts/vertice-source-reader.mjs';
import {
  handleWorkspaceDiffRequest,
  shouldHandleWorkspaceDiffRequest,
} from './scripts/vertice-workspace-diff.mjs';

function verticeAssistantSourcePlugin(
  rootDir: string,
  allowedWorkspacesEnv: string,
): Plugin {
  return {
    name: 'vertice-assistant-source-reader',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (handleAssistantSourceRequest(req, res, rootDir)) {
          return;
        }
        if (handleLocalFolderRequest(req, res)) {
          return;
        }
        if (shouldHandleWorkspaceDiffRequest(req.url)) {
          void handleWorkspaceDiffRequest(req, res, {
            rootDir,
            allowedWorkspacesEnv,
          });
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const proxyTarget = (
    env.VITE_AIONCORE_PROXY_TARGET ||
    process.env.VITE_AIONCORE_PROXY_TARGET ||
    ''
  ).trim();
  const allowedWorkspacesEnv = (
    env.VERTICE_ALLOWED_WORKSPACES ||
    process.env.VERTICE_ALLOWED_WORKSPACES ||
    env.VERTICE_WORKSPACE_ROOT ||
    process.env.VERTICE_WORKSPACE_ROOT ||
    ''
  ).trim();

  return {
    plugins: [
      react(),
      tailwindcss(),
      verticeAssistantSourcePlugin(import.meta.dirname, allowedWorkspacesEnv),
      // Copies src/assets into dist/ so root-relative URLs like
      // "/src/assets/images/..." (e.g. generate_image output) still resolve
      // in production builds. Do not remove.
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const rootDir = import.meta.dirname;
          const distDir = path.resolve(rootDir, 'dist');
          const srcAssets = path.resolve(rootDir, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, { recursive: true, force: true });
          }
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, '.'),
      },
    },
    build: {
      rolldownOptions: {
        output: {
          manualChunks(id: string) {
            const normalized = id.replaceAll('\\', '/');
            if (
              normalized.includes('node_modules/react/') ||
              normalized.includes('node_modules/react-dom/')
            ) {
              return 'react-vendor';
            }
            if (normalized.includes('/src/services/aionCore')) {
              return 'aion-core-gateway';
            }
            return undefined;
          },
        },
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      proxy: proxyTarget
        ? {
          '/api': {
            target: proxyTarget,
            changeOrigin: false,
          },
          '/health': {
            target: proxyTarget,
            changeOrigin: false,
          },
          '/login': {
            target: proxyTarget,
            changeOrigin: false,
          },
          '/logout': {
            target: proxyTarget,
            changeOrigin: false,
          },
          '/ws': {
            target: proxyTarget,
            ws: true,
            changeOrigin: false,
          },
        }
        : undefined,
    },
  };
});
