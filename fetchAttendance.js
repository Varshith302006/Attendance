const puppeteer = require('puppeteer-core');
const chromium = require('chromium');

// --- Single browser instance ---
let browser;

async function launchBrowser() {
  if (!browser) {
    console.log("Launching Chromium...");
    browser = await puppeteer.launch({
      headless: true, // set false to debug visually
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

// --- Open a new tab for each user ---
async function createUserPage() {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  return { page };
}

// --- Login ---
async function login(page, username, password) {
  try {
    await page.goto('https://samvidha.iare.ac.in/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.type('input[name="txt_uname"]', username, { delay: 0 });
    await page.type('input[name="txt_pwd"]', password, { delay: 0 });

    await Promise.all([
      page.click('#but_submit'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 })
    ]);

  } catch (err) {
    console.error("Login failed:", err.message);
    throw new Error("Login failed, check credentials or site availability.");
  }
}

// --- Fetch Academic Attendance ---
async function fetchAcademic(page) {
  try {
    await page.evaluate(() => {
      const link = document.querySelector('a[href*="action=stud_att_STD"]');
      if (link) link.click();
    });

    await page.waitForSelector('table tbody tr', { timeout: 20000 });

    const academicAttendance = await page.$$eval('table tbody tr', rows =>
      rows.map(row => {
        const cols = row.querySelectorAll('td');
        if (cols.length >= 8) {
          return {
            courseCode: cols[1].innerText.trim(),
            subject: cols[2].innerText.trim(),
            total: parseInt(cols[5].innerText.trim()),
            attended: parseInt(cols[6].innerText.trim()),
            percentage: parseFloat(cols[7].innerText.trim())
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

// --- Fetch Biometric Attendance ---
async function fetchBiometric(page) {
  const url = 'https://samvidha.iare.ac.in/home?action=std_bio';

  for (let attempt = 1; attempt <= 2; attempt++) { // retry once if fails
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector('table tbody tr', { timeout: 20000 });

      const rows = await page.$$eval('table tbody tr', rows =>
        rows.map(row => Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim()))
      );

      const totalDays = rows.length - 1;
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
      if (attempt === 2) throw new Error("Biometric attendance fetch failed.");
      await page.waitForTimeout(2000); // small delay before retry
    }
  }
}

// --- Helpers ---
function classesToReachTarget(attended, total, targetPercentage = 75) {
  const targetDecimal = targetPercentage / 100;
  const x = Math.ceil((targetDecimal * total - attended) / (1 - targetDecimal));
  return x > 0 ? x : 0;
}

function classesCanBunk(attended, total, targetPercentage = 75) {
  const targetDecimal = targetPercentage / 100;
  const x = Math.floor(attended / targetDecimal - total);
  return x > 0 ? x : 0;
}

// --- Exports ---
module.exports = { launchBrowser, createUserPage, login, fetchAcademic, fetchBiometric };
