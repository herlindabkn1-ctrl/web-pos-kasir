export default async function run(page, ui) {
  const types = await page.evaluate(() => ({
    muatProduk: typeof muatProduk,
    muatLaporan: typeof muatLaporanKeuangan,
    catat: typeof catatPengeluaran,
    proses: typeof prosesTransaksi,
    scriptCount: document.scripts.length,
    lastScriptLen: document.scripts[document.scripts.length-1].textContent.length,
    inlineErr: window.__lastError || null
  }));
  // also capture any page errors by injecting a listener then reloading
  await page.addInitScript(() => {
    window.__pageErrors = [];
    window.addEventListener('error', e => window.__pageErrors.push(e.message));
  });
  await page.reload();
  await page.waitForTimeout(2000);
  const errs = await page.evaluate(() => window.__pageErrors);
  return { ...types, pageErrors: errs };
}
