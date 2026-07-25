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

const ANSWERS = {
  maiden: 'Claire',
  highschool: 'rosemere high',
  pet: 'alexander',
  sex: 'male',
};

const SLOW = Number(process.env.SLOW || 1);
// login.js now forwards credentials to the real Odysseus server over
// fetch(), so this must be served over http (npm run mockup), not opened
// as a file:// URL.
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
  await page.goto(LOGIN_URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await ensureCursor(page);
  await wait(700);

  // --- Step 1: credentials ---
  await humanType(page, page.locator('#username'), USERNAME, 'Username');
  await humanType(page, page.locator('#password'), PASSWORD, 'Password');
  await humanClick(page, page.locator('#login-form button[type=submit]'), 'Sign In');

  await page.locator('#step-2').waitFor({ state: 'visible', timeout: 10000 });
  await wait(600);

  // --- Step 2: security questions ---
  await humanType(page, page.locator('#maiden-name'), ANSWERS.maiden, "Mother's maiden name");
  await humanType(page, page.locator('#highschool'), ANSWERS.highschool, 'First highschool');
  await humanType(page, page.locator('#pet'), ANSWERS.pet, 'First pet');
  await humanClick(page, page.locator(`input[name=sex][value=${ANSWERS.sex}]`), `Sex: ${ANSWERS.sex}`);
  await humanClick(
    page,
    page.locator('#security-form button[type=submit]'),
    'Verify & Access Terminal'
  );

  // --- Dashboard ---
  await page.waitForURL('**/index.html', { timeout: 15000 });
  await page.locator('.widgets-grid').waitFor();
  await ensureCursor(page);
  await wait(1200); // let the entry animations settle

  for (const symbol of ['SPY', 'QQQ', 'NVDA']) {
    const card = page.locator('.stock-card', {
      has: page.locator('.stock-symbol', { hasText: new RegExp(`^${symbol}$`) }),
    });
    await humanClick(page, card, `${symbol} card`);
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
