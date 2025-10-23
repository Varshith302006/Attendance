// fetchAttendance.js
const puppeteer = require('puppeteer-core');
const chromium = require('chromium');

// --- Single browser instance ---
let browser;
async function launchBrowser() {
  if (!browser) {
    console.log("Launching Chromium...");
    browser = await puppeteer.launch({
      headless: true, // set false while debugging
      executablePath: chromium.path,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-gpu',
        '--single-process'
      ],
      ignoreHTTPSErrors: true,
      defaultViewport: { width: 1280, height: 800 },
    });
    console.log("Chromium launched ✅");
  }
  return browser;
}

// --- Create a single page (compat) ---
async function createUserPage() {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  return { page };
}

// --- Create two pages and log in once, copy cookies to second page (for parallel fetch) ---
async function createUserPages() {
  const browser = await launchBrowser();
  const page1 = await browser.newPage();
  const page2 = await browser.newPage();
  return { page1, page2 };
}

// --- Login on a page (fills form + submit) ---
async function login(page, username, password) {
  try {
    await page.goto('https://samvidha.iare.ac.in/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    // fill fields
    await page.type('input[name="txt_uname"]', username, { delay: 0 });
    await page.type('input[name="txt_pwd"]', password, { delay: 0 });

    // submit and wait for DOM loaded (not networkidle)
    await Promise.all([
      page.click('#but_submit'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 })
    ]);

    // optionally confirm login succeeded; you can check for a known selector or user-specific element
    return true;
  } catch (err) {
    console.error("Login failed:", err.message);
    throw new Error("Login failed - check credentials or site availability");
  }
}

// --- Utility: copy cookies and localStorage from page1 -> page2 ---
async function replicateSession(pageFrom, pageTo) {
  // copy cookies
  const cookies = await pageFrom.cookies();
  if (cookies && cookies.length) {
    await pageTo.setCookie(...cookies);
  }

  // copy localStorage / sessionStorage (if site uses it)
  // We'll evaluate and transfer key/value pairs for localStorage and sessionStorage
  const storage = await pageFrom.evaluate(() => {
    return {
      local: Object.entries(window.localStorage || {}).map(([k, v]) => [k, v]),
      session: Object.entries(window.sessionStorage || {}).map(([k, v]) => [k, v])
    };
  });

  if (storage.local && storage.local.length) {
    await pageTo.evaluate((items) => {
      items.forEach(([k, v]) => window.localStorage.setItem(k, v));
    }, storage.local);
  }
  if (storage.session && storage.session.length) {
    await pageTo.evaluate((items) => {
      items.forEach(([k, v]) => window.sessionStorage.setItem(k, v));
    }, storage.session);
  }
}

// --- Direct URLs (you confirmed these) ---
const ACADEMIC_URL = 'https://samvidha.iare.ac.in/home?action=stud_att_STD';
const BIOMETRIC_URL = 'https://samvidha.iare.ac.in/home?action=std_bio';

// --- Fetch Academic Attendance (direct navigation) ---
async function fetchAcademic(page) {
  try {
    await page.goto(ACADEMIC_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('table tbody tr', { timeout: 20000 });

    const academicAttendance = await page.$$eval('table tbody tr', rows =>
      rows.map(row => {
        const cols = row.querySelectorAll('td');
        if (cols.length >= 8) {
          return {
            courseCode: cols[1].innerText.trim(),
            subject: cols[2].innerText.trim(),
            total: parseInt(cols[5].innerText.trim()) || 0,
            attended: parseInt(cols[6].innerText.trim()) || 0,
            percentage: parseFloat(cols[7].innerText.trim()) || 0
          };
        }
      }).filter(Boolean)
    );

    return academicAttendance.map(sub => ({
      ...sub,
      classesToAttendFor75: classesToReachTarget(sub.attended, sub.total),
      classesCanBunk: classesCanBunk(sub.attended, sub.total)
    }));
  } catch (err) {
    console.error("Failed to fetch academic attendance:", err.message);
    throw new Error("Academic attendance fetch failed.");
  }
}

// --- Fetch Biometric Attendance (direct navigation, with retry) ---
async function fetchBiometric(page) {
  const url = BIOMETRIC_URL;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('table tbody tr', { timeout: 20000 });

      const rows = await page.$$eval('table tbody tr', rows =>
        rows.map(row => Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim()))
      );

      const totalDays = Math.max(0, rows.length - 1);
      const presentCount = rows.filter(row => row.some(td => td.toLowerCase() === 'present')).length;
      const percentage = totalDays > 0 ? (presentCount / totalDays) * 100 : 0;

      return {
        totalDays,
        presentCount,
        percentage: Number(percentage.toFixed(2)),
        classesCanBunk: classesCanBunk(presentCount, totalDays),
        classesToAttendFor75: classesToReachTarget(presentCount, totalDays)
      };
    } catch (err) {
      console.warn(`Attempt ${attempt} failed for Biometric page: ${err.message}`);
      if (attempt === 2) {
        throw new Error("Biometric attendance fetch failed.");
      }
      await page.waitForTimeout(1500);
    }
  }
}

// --- Helpers ---
function classesToReachTarget(attended, total, targetPercentage = 75) {
  const targetDecimal = targetPercentage / 100;
  const needed = Math.ceil((targetDecimal * total - attended) / (1 - targetDecimal));
  return needed > 0 ? needed : 0;
}

function classesCanBunk(attended, total, targetPercentage = 75) {
  const targetDecimal = targetPercentage / 100;
  const x = Math.floor(attended / targetDecimal - total);
  return x > 0 ? x : 0;
}

// --- Exports ---
module.exports = {
  launchBrowser,
  createUserPage,
  createUserPages,
  login,
  replicateSession,
  fetchAcademic,
  fetchBiometric
};
