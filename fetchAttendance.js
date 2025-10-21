const puppeteer = require('puppeteer-core');
const chromium = require('chromium');

// --- Launch Browser at login page ---
async function launchBrowser() {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium.path,
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"]
  });

  const page = await browser.newPage();
  await page.goto('https://samvidha.iare.ac.in/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  return { browser, page };
}

// --- Login (reuse page at login URL) ---
async function login(page, username, password) {
  // Clear previous inputs if any
  await page.evaluate(() => {
    document.querySelector('input[name="txt_uname"]').value = '';
    document.querySelector('input[name="txt_pwd"]').value = '';
  });

  await page.type('input[name="txt_uname"]', username, { delay: 1 });
  await page.type('input[name="txt_pwd"]', password, { delay: 1 });
  await Promise.all([
    page.click('#but_submit'),
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 })
  ]);

    await page.waitForSelector('div#main', { timeout: 15000 });
}

// --- Reset page to login for next user ---
async function resetPageToLogin(page) {
  await page.goto('https://samvidha.iare.ac.in/', { waitUntil: 'domcontentloaded', timeout: 20000 });
}

// --- Fetch Academic Attendance ---
async function fetchAcademic(page) {
  // Wait for the attendance link to appear
  await page.waitForSelector('a[href*="action=stud_att_STD"]', { timeout: 15000 });
  
  // Click the link
  await Promise.all([
    page.click('a[href*="action=stud_att_STD"]'),
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 })
  ]);

  // Wait for table rows
  await page.waitForSelector('table tbody tr', { timeout: 15000 });

  const academicAttendance = await page.$$eval('table tbody tr', rows =>
    Array.from(rows)
      .filter(row => row.querySelectorAll('td').length >= 8)
      .map(row => {
        const cols = row.querySelectorAll('td');
        return {
          courseCode: cols[1].innerText.trim(),
          subject: cols[2].innerText.trim(),
          total: parseInt(cols[5].innerText.trim()),
          attended: parseInt(cols[6].innerText.trim()),
          percentage: parseFloat(cols[7].innerText.trim())
        };
      })
  );

  return academicAttendance.map(sub => ({
    ...sub,
    classesToAttendFor75: classesToReachTarget(sub.attended, sub.total),
    classesCanBunk: classesCanBunk(sub.attended, sub.total)
  }));
}

// --- Fetch Biometric Attendance ---
async function fetchBiometric(page) {
  await page.goto('https://samvidha.iare.ac.in/home?action=std_bio', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForSelector('table tbody tr', { timeout: 15000 });

  const rows = await page.$$eval('table tbody tr', rows =>
    Array.from(rows).map(row => Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim()))
  );

  const totalDays = rows.length - 1;
  const presentCount = rows.filter(row => row.some(td => td.toLowerCase() === 'present')).length;

  return {
    totalDays,
    presentCount,
    percentage: Number(((presentCount / totalDays) * 100).toFixed(2)),
    classesCanBunk: classesCanBunk(presentCount, totalDays),
    classesToAttendFor75: classesToReachTarget(presentCount, totalDays)
  };
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

module.exports = { launchBrowser, login, fetchAcademic, fetchBiometric, resetPageToLogin };
