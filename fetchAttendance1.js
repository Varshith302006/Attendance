const puppeteer = require('puppeteer-core');
const chromium = require('chromium');

// --- Launch Browser ---
async function launchBrowser() {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium.path,
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"]
  });
  const page = await browser.newPage();
  return { browser, page };
}

// --- Login ---
async function login(page, username, password) {
  await page.goto('https://samvidha.iare.ac.in/', { waitUntil: 'networkidle0', timeout: 60000 });
  await page.type('input[name="txt_uname"]', username, { delay: 10 });
  await page.type('input[name="txt_pwd"]', password, { delay: 10 });
  await Promise.all([
    page.click('#but_submit'),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
  ]);
}

// --- Fetch Academic Attendance ---
async function fetchAcademic(page) {
  await page.evaluate(() => document.querySelector('a[href*="action=stud_att_STD"]').click());
  await page.waitForSelector('table tbody tr', { timeout: 15000 });

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
}

// --- Fetch Biometric Attendance ---
async function fetchBiometric(page) {
  await page.goto('https://samvidha.iare.ac.in/home?action=std_bio', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('table tbody tr', { timeout: 15000 });

  const rows = await page.$$eval('table tbody tr', rows =>
    rows.map(row => {
      const cols = row.querySelectorAll('td');
      return Array.from(cols).map(td => td.innerText.trim());
    })
  );

  const totalDays = rows.length - 1; // exclude header
  const presentCount = rows.filter(row => row.some(td => td.toLowerCase() === 'present')).length;
  const percentage = totalDays > 0 ? (presentCount / totalDays) * 100 : 0;

  return {
    totalDays,
    presentCount,
    percentage: Number(percentage.toFixed(2)),
    classesCanBunk: classesCanBunk(presentCount, totalDays),         // number of leaves can take
    classesToAttendFor75: classesToReachTarget(presentCount, totalDays) // days to attend to reach 75%
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

module.exports = { launchBrowser, login, fetchAcademic, fetchBiometric };
