const puppeteer = require('puppeteer-core');
const chromium = require('chromium');

let browser; // persistent browser instance

// --- Launch or get persistent browser ---
async function getBrowser() {
  if (!browser) {
    console.log("Launching persistent browser...");
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    });
  }
  return browser;
}

// --- Create isolated page per request ---
async function getPage() {
  const browser = await getBrowser();
  const page = await browser.newPage();

  // Block images, fonts, stylesheets to speed up
  await page.setRequestInterception(true);
  page.on('request', req => {
    const type = req.resourceType();
    if (["image", "stylesheet", "font"].includes(type)) req.abort();
    else req.continue();
  });

  return page;
}

// --- Login ---
async function login(page, username, password) {
  try {
    console.log("Navigating to login page...");
    await page.goto('https://samvidha.iare.ac.in/', { waitUntil: 'networkidle0', timeout: 60000 });
    console.log("Typing credentials...");
    await page.type('input[name="txt_uname"]', username, { delay: 0 });
    await page.type('input[name="txt_pwd"]', password, { delay: 0 });
    console.log("Submitting login form...");
    await Promise.all([
      page.click('#but_submit'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 40000 })
    ]);
    console.log("Login successful!");
  } catch (err) {
    console.error("Login failed:", err.message);
    throw new Error("Login failed. Check credentials or portal accessibility.");
  }
}

// --- Fetch Academic Attendance ---
async function fetchAcademic(page) {
  try {
    console.log("Navigating to Academic Attendance page...");
    await page.evaluate(() => document.querySelector('a[href*="action=stud_att_STD"]').click());
    await page.waitForTimeout(1000); // allow redirect
    await page.waitForSelector('table tbody tr', { timeout: 40000 });
    console.log("Extracting academic attendance data...");

    const data = await page.$$eval('table tbody tr', rows =>
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

    return data.map(sub => ({
      ...sub,
      classesToAttendFor75: classesToReachTarget(sub.attended, sub.total),
      classesCanBunk: classesCanBunk(sub.attended, sub.total)
    }));

  } catch (err) {
    console.error("Academic table not found:", err.message);
    return [];
  }
}

// --- Fetch Biometric Attendance ---
async function fetchBiometric(page) {
  try {
    console.log("Navigating to Biometric Attendance page...");
    await page.goto('https://samvidha.iare.ac.in/home?action=std_bio', { waitUntil: 'networkidle2', timeout: 40000 });
    await page.waitForSelector('table tbody tr', { timeout: 40000 });
    console.log("Extracting biometric attendance data...");

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
    console.error("Biometric table not found:", err.message);
    return { totalDays: 0, presentCount: 0, percentage: 0, classesCanBunk: 0, classesToAttendFor75: 0 };
  }
}

// --- Helper functions ---
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

module.exports = { getPage, login, fetchAcademic, fetchBiometric };
