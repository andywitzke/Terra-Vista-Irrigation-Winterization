/**
 * Builds the user manual PDF from manual.html:
 *
 *   node docs/manual/build.js        (run capture.js first to refresh screenshots)
 */
const path = require('node:path');
const { execSync } = require('node:child_process');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require(path.join(execSync('npm root -g').toString().trim(), 'playwright')));
}

const OUT = path.join(__dirname, '..', 'Terra-Vista-Winterization-User-Manual.pdf');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`file://${path.join(__dirname, 'manual.html')}`, { waitUntil: 'load' });
  await page.pdf({
    path: OUT,
    format: 'Letter',
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: `<div style="width:100%; font: 8px sans-serif; color:#7a8a82; padding: 0 0.75in; display:flex; justify-content:space-between">
      <span>Terra Vista Sprinkler Winterization · User manual</span><span class="pageNumber"></span></div>`,
  });
  await browser.close();
  console.log('Wrote', OUT);
})();
