# Vértice Workspace — acompanhamento local v6

Plano ativo: `docs/implementation_plan_v6_local.md`. Instrução: `docs/hydrogen-local-v6.txt`.

## Baseline — 17/11/2026

Pasta ativa: `C:\llm\vertice-workspace`. Sem Git/publicação comprovados na extração. Visual aprovado como base, com refinamentos. Core oficial completo mantido; minimal-core futuro.

Cópia preservada do fonte recebido (sem `node_modules`, `.vertice`, `dist`, `test-results`, `.aistudio`, `.env.local` e logs): `C:\llm\vertice-workspace-baseline-20261117`.

Revisão inicial (`docs/revisao-local-v5-2026-11-17.md`): instalação original Windows não reproduzível; PID antigo podia encerrar processo alheio; URL malformada derrubava servidor; CI E2E não preparava `dist/`. Na cópia de diagnóstico com nativos suplementados: tipos/build, 40 testes e 1 E2E passaram, sem comprovar correções na pasta recebida nem integração real.

---

## V6-00 — Instalação, launcher, servidor e CI

**Estado**: Concluído em Windows (`Node v24.11.0`, `npm 11.6.1`); execução remota em Linux/CI pendente de publicação/execução em runner Linux.

### O que mudou
1. **Lockfile multiplataforma (`package-lock.json`)**:
   - Regenerado `package-lock.json` via `npm install --package-lock-only --no-audit --no-fund` mantendo `package.json` inalterado e preservando as versões originais dos pacotes principais, agora com `resolved`, `integrity` (SHA-512) e opcionais nativos para Windows e Linux (`@typescript/typescript-win32-x64` / `-linux-x64`, `@rolldown/binding-win32-x64-msvc` / `-linux-x64-gnu`, `@tailwindcss/oxide-win32-x64-msvc` / `-linux-x64-gnu`, `lightningcss-win32-x64-msvc` / `-linux-x64-gnu`, `@esbuild/win32-x64` / `-linux-x64`).
   - Removido `node_modules` recebido e validado `npm ci --no-audit --no-fund` limpo no Windows sem suplementação manual.
2. **Identidade verificável da instância no launcher e servidor (`scripts/vertice-ctl.mjs`, `scripts/vertice-server.mjs`)**:
   - `vertice-ctl.mjs start` gera `instanceId` (UUID) e `controlToken` aleatório de 32 bytes (armazenados em `.vertice/server.json` `schemaVersion: 2` com `mode: 0o600`), repassa via ambiente para o filho e só aceita prontidão após confirmação em `GET /__vertice_ctl/identity` com header `x-vertice-control-token` (`crypto.timingSafeEqual`).
   - `status`, `doctor` e `stop` verificam liveness do PID **e** identidade autenticada da instância antes de anunciar servidor ativo ou encerrar processo.
   - Registros ausentes, inválidos/corrompidos, legados sem `instanceId`/`controlToken`, mortos ou com PID vivo pertencente a outro processo/servidor alheio **recusam encerramento** (exit `1` em `stop`, sem `process.kill`).
   - `doctor` passa a validar a faixa exata de `engines.node` (`^22.12.0 || ^24.0.0 || >=26.0.0`) via `isSupportedNodeVersion` e nunca anuncia processo alheio como servidor identificado.
   - `stop` usa `POST /__vertice_ctl/shutdown` autenticado para encerramento gracioso e só recorre a `SIGTERM` após reconfirmar identidade da própria instância.
3. **Resiliência a URL malformada e validação de rota (`scripts/vertice-server.mjs`)**:
   - Adicionado `safeDecodePathname` no limite HTTP/WS (tratando `URIError` e bytes nulos `\0`), retornando `400 Bad Request` em `GET /%ZZ` ou `/%00` sem derrubar o servidor, mantendo requisições subsequentes válidas (`200 OK`), contenção em `dist/`, 404 de assets e fallback SPA.
   - Endurecido `resolveUpstreamTargetUrl` no proxy HTTP/WS para exigir origem relativa (`/`) e impedir resolução fora da origem do alvo configurado.
4. **Preparo de `dist/` no job E2E da CI (`.github/workflows/ci.yml`)**:
   - Adicionada etapa `npm run build` no job `e2e-browser` antes de `npm run test:e2e`.
5. **Regressões automatizadas (`src/services/__tests__/localServerProxy.test.ts`, `src/services/__tests__/verticeLauncher.test.ts`)**:
   - Cobertura para `GET /%ZZ` (`400`) + `GET /` (`200`) em processo filho real, proteção do endpoint `/__vertice_ctl/*`, verificação de faixa Node, registro ausente/inválido/legado/morto, PID reutilizado por processo descartável ou servidor HTTP alheio, porta ocupada, start duplicado e ciclo completo `doctor → start → status → GET → stop → status`.

### Comandos e resultados observados (sem mocks no ambiente de instalação/servidor)
- Ambiente utilizado: `C:\Users\joao.gonzales\AppData\Roaming\AionUi-Dev\aionui\runtime\node\node-v24.11.0-win-x64` (`Node v24.11.0`, `npm 11.6.1`).
- `Remove-Item -Recurse -Force node_modules; npm ci --no-audit --no-fund`: **aprovado** (`added 241 packages`, opcionais `win32-x64` presentes).
- `npm run lint` (`tsc --noEmit`): **aprovado** (`0` erros).
- `npm test` (`vitest run` — testes unitários, fixtures e subprocessos locais reais): **aprovado** — **8 arquivos, 46/46 testes** (6,04s).
- `npm run clean && npm run build`: **aprovado** em 964ms (0 avisos de chunk > 500 kB).
- `npm run server:doctor`: **aprovado** (Node `v24.11.0` compatível, `dist/` encontrado, porta `4173` livre).
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" npm run test:e2e`: **aprovado** — **1/1 E2E** no navegador Chrome real em modo Demonstração (8,7s).

### Limitações e próximo passo
- `npm ci` e execução em **Linux** (incluindo pipeline remota GitHub Actions) ficam pendentes de execução em ambiente Linux/remoto após publicação.
- **Próximo marco**: `V6-01` — Preparar Core dedicado (`aioncore.exe v0.2.2`), origem estável, proxy e autenticação real.

---

## Marcos — estado atualizado

- V6-00 — Instalação/launcher/servidor/CI: **concluído no Windows** (Linux/CI remota pendentes de runner).
- V6-01 — Core dedicado, origem e autenticação reais: **em andamento**.
- V6-02 — Primeira sessão real e continuidade: pendente.
- V6-03 — Equipe/modelos/papéis/capacidades: comprovação real pendente.
- V6-04 — Autoridade de coordenação/ciclo real: pendente.
- V6-05 — Permissões/correção/falhas/limites: comprovação real pendente.
- V6-06 — Contexto/sessões/dados/recuperação: comprovação real pendente.
- V6-07 — Acabamento/primeiro uso: base visual aprovada; refinamentos e validação real pendentes.
- V6-08 — Distribuição/operação: concluído launcher/servidor base; integração com Core real pendente.
- V6-09 — Validação integrada/release: pendente.
- V6-10 — Versionamento/GitHub/documentação: pendente; remoto não definido nesta entrega.
