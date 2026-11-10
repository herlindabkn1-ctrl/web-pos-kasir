export default async function run(page, ui) {
  await page.addInitScript(() => {
    window.__pageErrors = [];
    window.addEventListener('error', e => window.__pageErrors.push(String(e.message)));
    window.addEventListener('unhandledrejection', e => window.__pageErrors.push('rej: ' + String(e.reason)));
  });
  await page.goto('http://localhost:3000');
  await page.waitForTimeout(2500);
  const errs = await page.evaluate(() => window.__pageErrors);
  return { errs };
}
