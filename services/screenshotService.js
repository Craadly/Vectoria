'use strict';

const puppeteer = require('puppeteer');

/**
 * Capture a PNG screenshot of a given URL. Defaults to viewport 1024x1024.
 * Returns a Buffer with the PNG image data.
 */
async function captureScreenshot(url, options = {}) {
  const width = options.width || 1024;
  const height = options.height || 1024;
  const fullPage = options.fullPage || false;

  const launchOptions = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  };

  const browser = await puppeteer.launch(launchOptions);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Try to hide potential cookie banners quickly (best-effort)
    try {
      await page.addStyleTag({
        content:
          '.cookies, .cookie, .cc-banner, .cky-consent-bar, .eu-cookie-compliance, .consent, .banner{ display:none !important; }',
      });
    } catch {}

    const buffer = await page.screenshot({ type: 'png', fullPage });
    return buffer;
  } finally {
    await browser.close();
  }
}

module.exports = {
  captureScreenshot,
};
