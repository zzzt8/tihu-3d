import puppeteer from 'puppeteer';

const url = process.argv[2] || 'https://litter.catbox.moe/c7kscq.html';
const out = process.argv[3] || '/tmp/tihu-screenshot.png';
const browser = await puppeteer.launch({
  headless: 'new',
  args: [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise(r => setTimeout(r, 4000));
await page.screenshot({ path: out, fullPage: false });
console.log('Screenshot saved to', out);
await browser.close();
