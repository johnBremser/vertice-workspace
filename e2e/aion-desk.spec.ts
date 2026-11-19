import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  REAL_CORE_AGENTS_MANAGEMENT_V022,
  REAL_CORE_ASSISTANTS_V022,
  REAL_CORE_HEALTH_V022,
} from '../src/services/__tests__/fixtures/coreV022RealPayloads';

test.describe('Vértice Workspace — AionCore Local E2E', () => {
  test('starts cleanly in AionCore local mode without demo seeds, authenticates and auto-loads real CLI models, manages project/conversation/tasks/context/backup, and preserves layout across themes and viewports', async ({
    page,
  }, testInfo) => {
    let authenticated = false;

    await page.route('**/health', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(REAL_CORE_HEALTH_V022),
      });
    });

    await page.route('**/api/auth/status', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          is_authenticated: authenticated,
          needs_setup: false,
          user: authenticated ? { id: 'usr_e2e', username: 'admin' } : null,
        }),
      });
    });

    await page.route('**/login', async (route) => {
      authenticated = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          message: 'Login realizado com sucesso',
          user: { id: 'usr_e2e', username: 'admin' },
        }),
      });
    });

    await page.route('**/api/agents/management', async (route) => {
      if (!authenticated) {
        await route.fulfill({ status: 401, body: JSON.stringify({ error: 'Unauthorized' }) });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: REAL_CORE_AGENTS_MANAGEMENT_V022 }),
      });
    });

    await page.route('**/api/assistants', async (route) => {
      if (!authenticated) {
        await route.fulfill({ status: 401, body: JSON.stringify({ error: 'Unauthorized' }) });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: REAL_CORE_ASSISTANTS_V022 }),
      });
    });

    await page.route('**/api/teams', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      });
    });

    await page.goto('/');

    // 1. Starts directly in AionCore local mode with ZERO demonstration data
    await expect(page.getByText('Portal de demonstração')).toHaveCount(0);
    await expect(page.getByText(/\(Demonstração\)/i)).toHaveCount(0);
    await expect(page.getByText(/AionCore local/i).first()).toBeVisible();
    await expect(
      page.getByText('Pronto para operar com seus agentes locais'),
    ).toBeVisible();

    // 2. Open Settings, log in to AionCore, and verify real CLI catalog auto-loads
    await page.getByRole('button', { name: /Configurações/i }).first().click();
    await expect(page.getByLabel('Usuário WebUI')).toBeVisible();
    await page.getByLabel('Usuário WebUI').fill('admin');
    await page.getByLabel('Senha (não persistida)').fill('senha-teste');
    await page.getByRole('button', { name: /Autenticar \(\/login\)/i }).click();

    // Login form collapses into authenticated bar and real CLI catalog auto-loads
    await expect(
      page.getByText(/Sessão WebUI autenticada no navegador/i),
    ).toBeVisible();
    await expect(page.getByText('Codex (AionCore)').first()).toBeVisible();
    await expect(page.getByText('Carregado (1)').first()).toBeVisible();

    // 3. Create a real project and conversation using the discovered Core CLIs
    await page.getByRole('button', { name: /Voltar às conversas/i }).click();
    await page.getByRole('button', { name: /Novo projeto/i }).first().click();
    await page.getByLabel('Nome do projeto').fill('Projeto Real E2E');
    await page.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByText('Projeto Real E2E').first()).toBeVisible();

    await page
      .getByRole('button', { name: /Nova conversa em Projeto Real E2E/i })
      .click();
    await page.getByLabel('Título da conversa').fill('Fluxo Real AionCore E2E');
    await page
      .getByLabel('Preset inicial de equipe')
      .selectOption('preset_terra_sol_gemini');
    await page.getByRole('button', { name: 'Salvar' }).click();

    await expect(page.getByRole('tab', { name: /Terra 6\.1/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Sol 6\.1/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Gemini Hydrogen/i })).toBeVisible();
    await expect(page.getByText(/\(Demonstração\)/i)).toHaveCount(0);

    // 3b. Verify real CLI models appear in the conversation's participant settings
    await page.getByRole('button', { name: /Configurações/i }).first().click();
    await expect(
      page.locator('option', { hasText: /GPT-5\.6-Luna/i }).first(),
    ).toBeAttached();
    await page.getByRole('button', { name: /Voltar às conversas/i }).click();

    // 4. Open Trabalho drawer if closed, create a task, and publish Shared Context v1
    const tasksTab = page.getByRole('tab', { name: /Tarefas/i });
    if (!(await tasksTab.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: /Trabalho/i }).click();
    }
    await tasksTab.click();
    await page.getByRole('button', { name: /Nova tarefa/i }).click();
    await page.getByLabel('Título').fill('Validar catálogo real do CLI');
    await page.getByRole('button', { name: 'Criar tarefa' }).click();
    await expect(
      page.getByRole('heading', { name: 'Validar catálogo real do CLI' }),
    ).toBeVisible();

    await page.getByRole('tab', { name: /Contexto compartilhado/i }).click();
    await page.getByRole('button', { name: /Nova revisão/i }).click();
    await page.getByLabel('Resumo da alteração').fill('Revisão E2E AionCore');
    await page.getByRole('button', { name: /Publicar revisão/i }).click();
    await expect(page.getByText('Revisão E2E AionCore').first()).toBeVisible();

    await page.getByRole('button', { name: 'Fechar painel lateral' }).click();

    // 5. Real JSON Backup Export -> Upload -> Validate -> Import as Copy (preserving live Core session)
    await page.getByRole('button', { name: /Exportar \/ Backup/i }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page
      .getByRole('button', { name: /Backup JSON completo do workspace/i })
      .click();
    const download = await downloadPromise;
    const savedBackupPath = path.join(testInfo.outputDir, download.suggestedFilename());
    await download.saveAs(savedBackupPath);

    const exportedJsonText = await fs.readFile(savedBackupPath, 'utf8');
    expect(exportedJsonText).toContain('"exportSchemaVersion": "2.0.0"');
    expect(exportedJsonText).toContain('Fluxo Real AionCore E2E');
    expect(exportedJsonText).not.toContain('aionui-csrf-token');

    await page.locator('#backup-file-input').setInputFiles(savedBackupPath);
    await expect(page.getByText('Backup validado antes da importação')).toBeVisible();
    await page.getByRole('button', { name: 'Importar como cópia' }).click();
    await expect(
      page.getByText(/Backup importado como cópia com novos identificadores/i),
    ).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByText(/\(cópia\)/i).first()).toBeVisible();

    // 6. Toggle theme and check responsive layout (1440, 1024, 390) + mobile drawers
    await page.getByRole('button', { name: /Mudar para tema (claro|escuro)/i }).click();
    for (const vp of [
      { width: 1440, height: 900 },
      { width: 1024, height: 768 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(vp);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      expect(overflow).toBe(false);
    }

    // Mobile (390x844): open & close Trabalho drawer and project sidebar without horizontal overflow
    await page.getByRole('button', { name: /Trabalho/i }).click();
    await expect(page.getByRole('tab', { name: /Tarefas/i })).toBeVisible();
    await page.getByRole('button', { name: 'Fechar painel lateral' }).click();
    await expect(page.getByRole('button', { name: 'Fechar painel lateral' })).toHaveCount(0);

    await page
      .getByRole('button', { name: 'Alternar barra lateral de projetos' })
      .click();
    await expect(page.getByRole('button', { name: 'Fechar barra lateral' })).toBeVisible();
    await page.getByRole('button', { name: 'Fechar barra lateral' }).click();
    await expect(page.getByRole('button', { name: 'Fechar barra lateral' })).toHaveCount(0);

    const mobileOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(mobileOverflow).toBe(false);
  });
});
