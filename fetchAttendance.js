const puppeteer = require('puppeteer-core');
const chromium = require('chromium'); // provides a working Chrome binary on Render

async function fetchAttendance(username, password) {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium.path, // important!
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage"
    ],
    timeout: 60000 // increase timeout to 60s for slower serverless environments
  });

  const page = await browser.newPage();

  // --- Login ---
  await page.goto('https://samvidha.iare.ac.in/', { waitUntil: 'domcontentloaded' });
  await page.type('input[name="txt_uname"]', username, { delay: 50 });
  await page.type('input[name="txt_pwd"]', password, { delay: 50 });
  await page.click('#but_submit');
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });

  // --- Academic Attendance ---
  await page.waitForSelector('a[href*="action=stud_att_STD"]', { timeout: 15000 });
  await page.evaluate(() => document.querySelector('a[href*="action=stud_att_STD"]').click());
  await page.waitForSelector('table tbody tr', { timeout: 20000 });

  const academicAttendance = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    return rows.map(row => {
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
    }).filter(Boolean);
  });

  const academicWithTargets = academicAttendance.map(sub => ({
    ...sub,
    classesToAttendFor75: classesToReachTarget(sub.attended, sub.total, 75),
    classesCanBunk: classesCanBunk(sub.attended, sub.total, 75)
  }));

  // --- Biometric Attendance ---
  await page.goto('https://samvidha.iare.ac.in/home?action=std_bio', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table tbody tr', { timeout: 20000 });

  const biometricAttendance = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    const totalDays = rows.length - 1;
    const presentCount = rows.filter(row => {
      const cols = row.querySelectorAll('td');
      return Array.from(cols).some(td => td.innerText.trim().toLowerCase() === 'present');
    }).length;

    return {
      totalDays,
      presentCount,
      percentage: totalDays > 0 ? ((presentCount / totalDays) * 100).toFixed(2) : 0
    };
  });

  await browser.close();
  return { academicWithTargets, biometricAttendance };
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

module.exports = fetchAttendance;
