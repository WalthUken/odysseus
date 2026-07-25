/**
 * Visible browser demo bot for mockup_website.
 *
 * Opens login.html in a real (headed) Chromium window, types the credentials and
 * security answers character-by-character, then drives the dashboard. A fake
 * cursor is drawn into the page so you can watch it glide and click.
 *
 * Usage:
 *   node scripts/mockup-demo-bot.js
 *   LOGIN_USER=x LOGIN_PASS=y node scripts/mockup-demo-bot.js   # override creds
 *   SLOW=2 node scripts/mockup-demo-bot.js                      # 2x slower
 */

const { chromium } = require('playwright');

// The mockup only accepts these; override with env vars if the page changes.
const USERNAME = process.env.LOGIN_USER || 'username';
const PASSWORD = process.env.LOGIN_PASS || 'password';

const SLOW = Number(process.env.SLOW || 1);
// The mockup must be loaded over HTTP, not file://. Sign-in, password recovery
// and the silent telemetry upload are all same-origin fetches against the
// mockup server, and every one of them fails from a file:// page.
const MOCKUP_ORIGIN = process.env.MOCKUP_ORIGIN || 'http://127.0.0.1:4000';
const LOGIN_URL = `${MOCKUP_ORIGIN}/login.html`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms * SLOW));

/* ---------- fake cursor ---------- */

const CURSOR_SCRIPT = () => {
  if (window.__botCursor) return;
  const dot = document.createElement('div');
  dot.id = '__bot-cursor';
  dot.style.cssText = [
    'position:fixed', 'left:0', 'top:0', 'width:22px', 'height:22px',
    'margin:-11px 0 0 -11px', 'border-radius:50%',
    'background:rgba(56,189,248,.35)', 'border:2px solid #38bdf8',
    'box-shadow:0 0 12px 4px rgba(56,189,248,.5)',
    'pointer-events:none', 'z-index:2147483647',
    'transition:transform .08s linear',
  ].join(';');
  document.documentElement.appendChild(dot);
  window.__botCursor = dot;
  window.__botMove = (x, y) => {
    dot.style.transform = `translate(${x}px, ${y}px)`;
  };
  window.__botClick = () => {
    dot.animate(
      [{ transform: dot.style.transform + ' scale(1)' },
       { transform: dot.style.transform + ' scale(.55)' },
       { transform: dot.style.transform + ' scale(1)' }],
      { duration: 260 }
    );
  };
};

async function ensureCursor(page) {
  await page.evaluate(CURSOR_SCRIPT).catch(() => {});
}

/** Move the real mouse in small steps, keeping the drawn cursor in sync. */
async function glideTo(page, x, y, steps = 24) {
  await ensureCursor(page);
  const from = page.__pos || { x: 40, y: 40 };
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // easeInOutQuad
    const cx = from.x + (x - from.x) * ease;
    const cy = from.y + (y - from.y) * ease;
    await page.mouse.move(cx, cy);
    await page.evaluate(([px, py]) => window.__botMove?.(px, py), [cx, cy]);
    await wait(10);
  }
  page.__pos = { x, y };
}

async function moveToLocator(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  await wait(150);
  const box = await locator.boundingBox();
  if (!box) throw new Error('element has no box');
  await glideTo(page, box.x + box.width / 2, box.y + box.height / 2);
}

async function humanClick(page, locator, label) {
  if (label) console.log(`click  -> ${label}`);
  await moveToLocator(page, locator);
  await page.evaluate(() => window.__botClick?.());
  await wait(120);
  await locator.click();
  await wait(400);
}

async function humanType(page, locator, text, label) {
  console.log(`type   -> ${label}: ${text}`);
  await moveToLocator(page, locator);
  await page.evaluate(() => window.__botClick?.());
  await locator.click();
  await wait(200);
  for (const ch of text) {
    await page.keyboard.type(ch);
    await wait(60 + Math.random() * 90); // uneven, human-ish cadence
  }
  await wait(300);
}

async function smoothScroll(page, totalPx, stepPx = 60) {
  for (let moved = 0; moved < totalPx; moved += stepPx) {
    await page.mouse.wheel(0, stepPx);
    await wait(30);
  }
  await wait(500);
}

/* ---------- the run ---------- */

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 40 * SLOW });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // Re-inject the cursor after every navigation (login.html -> index.html).
  await context.addInitScript(CURSOR_SCRIPT);
  const page = await context.newPage();

  console.log(`open   -> ${LOGIN_URL}`);
  try {
    await page.goto(LOGIN_URL);
  } catch (error) {
    await browser.close();
    throw new Error(
      `Could not open ${LOGIN_URL}. Start the mockup with `
      + `"node mockup_website/server.js" (and Odysseus with "npm start") first.\n`
      + error.message,
    );
  }
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await ensureCursor(page);
  await wait(700);

  // --- Step 1: credentials ---
  await humanType(page, page.locator('#username'), USERNAME, 'Username');
  await humanType(page, page.locator('#password'), PASSWORD, 'Password');
  await humanClick(page, page.locator('#login-form button[type=submit]'), 'Sign In');

  // Signing in now lands on the dashboard directly. The security questions
  // moved behind "Forgot your password?" and are no longer part of this path.

  // --- Dashboard ---
  await page.waitForURL('**/index.html', { timeout: 15000 });
  await page.locator('.widgets-grid').waitFor();
  await ensureCursor(page);
  await wait(1200); // let the entry animations settle

  // Open each ticker and place an order. The quantity and limit fields are the
  // only keyboard source on this page, and keystroke timing is what the
  // behavioral check actually leans on, so a run that only moves the mouse
  // exercises almost none of the detection path.
  const ORDERS = [
    { symbol: 'SPY', quantity: '25', limit: '512.40' },
    { symbol: 'QQQ', quantity: '10', limit: '438.15' },
    { symbol: 'NVDA', quantity: '5', limit: '121.80' },
  ];

  for (const order of ORDERS) {
    const card = page.locator('.stock-card', {
      has: page.locator('.stock-symbol', { hasText: new RegExp(`^${order.symbol}$`) }),
    });
    await humanClick(page, card, `${order.symbol} card`);
    await page.locator('#ticker-modal').waitFor({ state: 'visible', timeout: 10000 });
    await wait(500);

    await humanType(page, page.locator('#order-quantity'), order.quantity, 'Quantity');
    await humanType(page, page.locator('#order-limit'), order.limit, 'Limit price');
    await humanClick(page, page.locator('#order-submit'), `Submit ${order.symbol} order`);
    await wait(700);

    await humanClick(page, page.locator('#ticker-modal-close'), 'Close ticker');
    await page.locator('#ticker-modal').waitFor({ state: 'hidden', timeout: 10000 });
    await wait(400);
  }

  await humanClick(page, page.locator('#theme-toggle'), 'Night/light mode toggle');
  await wait(800);

  console.log('scroll -> Most Active Options');
  await smoothScroll(page, 900);
  await moveToLocator(page, page.locator('section.table-container h3'));
  await wait(3000);

  console.log('done. Press Ctrl+C to close the browser.');
  await new Promise(() => {}); // keep the window open for viewing
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
