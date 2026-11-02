import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'

// Uses real choir material that is not in the repo. Set MATERIAL_DIR to a folder of song folders.
const DIR = process.env.MATERIAL_DIR
test.skip(!DIR || !existsSync(DIR), 'MATERIAL_DIR not set')

test('write the voices out as notes', async ({ page }) => {
  await page.goto('./')
  await page.locator('input[webkitdirectory]').setInputFiles(DIR!)
  await expect(page.getByText(/låt(ar)? hittade/)).toBeVisible({ timeout: 1_200_000 })
  await page.getByRole('button', { name: 'Alt 2', exact: true }).click()
  await page.getByPlaceholder('Ditt förnamn').fill('Ella')
  await page.getByRole('button', { name: 'Kör igång' }).click()
  await expect(page.getByText('Dagens pass')).toBeVisible()
  const card = page.getByRole('button', { name: /Fix you/i }).first()
  await card.click()
  await page.getByRole('button', { name: 'Noter' }).click()
  await page.getByRole('button', { name: 'Skriv ut noter' }).click()
  await expect(page.getByText('Text under')).toBeVisible({ timeout: 1_200_000 })
  await expect(page.getByText(/Skriver ut/)).toBeHidden({ timeout: 1_200_000 })
  await page.waitForTimeout(3000)
  await page.screenshot({ path: 'test-results/notes-01-all.png', fullPage: true })
  await page.getByRole('radiogroup').getByRole('radio', { name: 'Sopran' }).click()
  await page.getByRole('button', { name: 'Alt 1', exact: true }).first().click()
  await page.waitForTimeout(2000)
  await page.screenshot({ path: 'test-results/notes-02-toggled.png', fullPage: true })
  await page.locator('svg').first().click({ position: { x: 200, y: 400 } })
  await page.waitForTimeout(2500)
  await page.screenshot({ path: 'test-results/notes-03-playing.png' })
})
