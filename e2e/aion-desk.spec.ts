import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test.describe('Aion Desk v4 E2E flow', () => {
  test('completes Terra/Sol/Gemini conversation to Concluída without seq gaps, handles denied permission & reload reconciliation, performs real JSON backup export/import, verifies 2,000-event DOM pagination & scroll, and checks themes + viewports', async ({
    page,
  }, testInfo) => {
    await page.goto('/');

    // 1. Initial load shows Portal de demonstração
    await expect(page.getByText('Portal de demonstração').first()).toBeVisible();

    // 2. Open Settings and inspect 6-state catalog + configurable team
    await page.getByRole('button', { name: /Configurações/i }).click();
    await expect(
      page.getByText('Equipe configurável, papéis e presets da conversa ativa'),
    ).toBeVisible();
    await expect(page.getByText('1. Configurada').first()).toBeVisible();

    // 3. Create new conversation with Terra 6.1 / Sol 6.1 / Gemini Hydrogen
    await page.getByRole('button', { name: /Voltar às conversas/i }).click();
    await page
      .getByRole('button', { name: /Nova conversa em Portal de demonstração/i })
      .click();
    await page.getByLabel('Título da conversa').fill('Fluxo Terra Sol Gemini E2E');
    await page
      .getByLabel('Preset inicial de equipe')
      .selectOption('preset_terra_sol_gemini');
    await page.getByRole('button', { name: 'Salvar' }).click();

    await expect(page.getByRole('tab', { name: /Terra 6\.1/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Sol 6\.1/i })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Gemini Hydrogen/i })).toBeVisible();

    // 4. Send initial message in General + Step forward -> MUST NOT create a seq gap (Fix 1)
    const composer = page.getByPlaceholder(
      /Enviar pedido ou orientação ao coordenador/i,
    );
    await composer.fill('Organizar plano inicial da equipe configurável');
    await page.getByRole('button', { name: 'Enviar' }).click();
    await expect(
      page.getByText('Organizar plano inicial da equipe configurável'),
    ).toBeVisible();

    await page.getByRole('button', { name: /Avançar cenário/i }).click();
    await expect(page.getByText(/Lacuna detectada/i)).toHaveCount(0);

    // 5. Ensure Trabalho drawer is open (or open it), create a manual 3rd task, and publish Context v1
    await page.getByRole('button', { name: /Avançar cenário/i }).click();
    const tasksTab = page.getByRole('tab', { name: /Tarefas/i });
    if (!(await tasksTab.isVisible().catch(() => false))) {
      await page.getByRole('button', { name: /Trabalho/i }).click();
    }
    await tasksTab.click();
    await page.getByRole('button', { name: /Nova tarefa/i }).click();
    await page.getByLabel('Título').fill('Auditar exportação JSON');
    await page.getByRole('button', { name: 'Criar tarefa' }).click();
    await expect(
      page.getByRole('heading', { name: 'Auditar exportação JSON' }),
    ).toBeVisible();

    await page.getByRole('tab', { name: /Contexto compartilhado/i }).click();
    await page.getByRole('button', { name: /Nova revisão/i }).click();
    await page.getByLabel('Resumo da alteração').fill('Revisão E2E publicada');
    await page.getByRole('button', { name: /Publicar revisão/i }).click();
    await expect(page.getByText('Revisão E2E publicada').first()).toBeVisible();

    // Close right drawer so main stream stays unobscured
    await page.getByRole('button', { name: 'Fechar painel lateral' }).click();

    // 6. Advance Terra/Sol/Gemini + 3rd manual task step-by-step all the way to Concluída
    const stepButton = page.getByRole('button', { name: /Avançar cenário/i });
    for (let i = 0; i < 35; i += 1) {
      if (
        await page
          .locator('header')
          .getByText('Concluída', { exact: true })
          .first()
          .isVisible()
          .catch(() => false)
      ) {
        break;
      }
      const approvePermBtn = page
        .getByRole('button', { name: /Aprovar no escopo simulado/i })
        .first();
      if (await approvePermBtn.isVisible().catch(() => false)) {
        await approvePermBtn.click();
        continue;
      }
      const approveEscBtn = page
        .getByRole('button', { name: /Aprovar promoção para/i })
        .first();
      if (await approveEscBtn.isVisible().catch(() => false)) {
        await approveEscBtn.click();
        continue;
      }
      if (await stepButton.isDisabled().catch(() => false)) {
        break;
      }
      await stepButton.click();
    }

    await expect(
      page.locator('header').getByText('Concluída', { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /Trabalho/i })).toContainText('3/3');

    // 7. Create another conversation to test denied permission blocking + gap across reload
    await page
      .getByRole('button', { name: /Nova conversa em Portal de demonstração/i })
      .click();
    await page.getByLabel('Título da conversa').fill('Permissão e Reconciliação E2E');
    await page.getByRole('button', { name: 'Salvar' }).click();

    await page
      .getByRole('button', { name: /Mais controles de simulação/i })
      .click();
    await page
      .getByRole('menuitem', { name: /Solicitar permissão simulada/i })
      .click();
    await expect(page.getByRole('button', { name: 'Recusar' }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Recusar' }).first().click();

    await page.getByRole('button', { name: /Executar automaticamente/i }).click();
    await expect(page.getByText(/recusada/i).first()).toBeVisible();

    await page
      .getByRole('button', { name: /Mais controles de simulação/i })
      .click();
    await page
      .getByRole('menuitem', { name: /Simular evento fora de ordem/i })
      .click();
    await expect(
      page.getByRole('button', { name: /Reconciliar agora/i }),
    ).toBeVisible();
    await expect(page.getByText('Salvo', { exact: true })).toBeVisible();

    await page.reload();
    await expect(
      page.getByRole('button', { name: /Reconciliar agora/i }),
    ).toBeVisible();
    await page.getByRole('button', { name: /Reconciliar agora/i }).click();
    await expect(page.getByText(/Reconciliação concluída/i)).toBeVisible();

    // 8. Real JSON Backup Export -> Upload -> Validate -> Import as Copy -> Assert UI updates
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
    expect(exportedJsonText).toContain('Fluxo Terra Sol Gemini E2E');
    expect(exportedJsonText).not.toContain('aionui-csrf-token');

    await page.locator('#backup-file-input').setInputFiles(savedBackupPath);
    await expect(page.getByText('Backup validado antes da importação')).toBeVisible();
    await page.getByRole('button', { name: 'Importar como cópia' }).click();
    await expect(
      page.getByText(/Backup importado como cópia com novos identificadores/i),
    ).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByText(/\(cópia\)/i).first()).toBeVisible();

    // 9. 2,000-event performance stress test: verify real mounted DOM cap + load-older scroll
    await page
      .getByRole('button', { name: /Mais controles de simulação/i })
      .click();
    await page
      .getByRole('menuitem', { name: /Carregar teste de desempenho \(2\.000 eventos\)/i })
      .click();

    await page.getByRole('tab', { name: /Executor/i }).click();

    const loadOlderBtn = page.getByRole('button', {
      name: /Carregar eventos anteriores/i,
    });
    await expect(loadOlderBtn).toBeVisible();
    const mountedCountBefore = await page.locator('main article').count();
    expect(mountedCountBefore).toBeLessThanOrEqual(45);
    expect(mountedCountBefore).toBeGreaterThan(0);

    await loadOlderBtn.click();
    const mountedCountAfter = await page.locator('main article').count();
    expect(mountedCountAfter).toBeGreaterThan(mountedCountBefore);
    expect(mountedCountAfter).toBeLessThanOrEqual(90);

    // 10. Toggle theme and check responsive layout (1440, 1024, 390) + mobile drawers
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
