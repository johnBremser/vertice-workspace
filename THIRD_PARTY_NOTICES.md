# Avisos de Terceiros e Atribuições — Vértice Workspace

Este projeto incorpora contratos, padrões arquitetônicos e dependências open-source listados abaixo, preservando integralmente suas licenças e atribuições originais.

---

## 1. Projetos de referência e contratos (`Apache-2.0`)

### AionUi (`2.2.2`)
- **Origem**: `AionUi` (`commit e108b6b56b1a6eb99a00904878d0582f657b2908`)
- **Licença**: Apache License 2.0 (`Apache-2.0`)
- **Uso no Vértice Workspace**: padrão de *single-flight session refresh coalescing* e ponte HTTP/WebSocket com CSRF adaptado em [`src/services/aionCoreTransport.ts`](src/services/aionCoreTransport.ts) (cabeçalho `@license Copyright 2025 AionUi` preservado).

### AionCore (`v0.2.2`)
- **Origem**: `AionCore` (`commit 503a87199eb978790ca77675b39c84b241535bf3`, Apache-2.0)
- **Papel**: runtime local independente executado fora do pacote frontend (comunicação exclusiva via HTTP/WebSocket em loopback e proxy de mesma origem), contratos de DTO documentados em [`docs/aioncore-integration.md`](docs/aioncore-integration.md) e [`src/services/aionCoreDtos.ts`](src/services/aionCoreDtos.ts). **Não** é importado nem empacotado dentro do bundle frontend (`dist/`).

---

## 2. Dependências npm declaradas (`package.json` / `package-lock.json`)

Todas as dependências de produção e desenvolvimento estão fixadas no `package-lock.json` e são instaladas via `npm ci`:

- **Runtime frontend (`dependencies`)**: `react`, `react-dom`, `react-markdown`, `lucide-react`, `@tailwindcss/vite`, `@vitejs/plugin-react`, `vite`, `vitest`.
- **Desenvolvimento e testes (`devDependencies`)**: `typescript`, `@playwright/test`, `tailwindcss`, `autoprefixer`, `esbuild`, `@types/node`, `@types/react`, `@types/react-dom`.
- **Servidor e launcher locais (`scripts/vertice-server.mjs`, `scripts/vertice-ctl.mjs`)**: utilizam exclusivamente módulos nativos do Node.js (`node:*`), sem dependências npm extras em execução após `npm run build`.
