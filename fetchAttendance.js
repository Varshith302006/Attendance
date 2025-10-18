const puppeteer = require('puppeteer-core');
const chromium = require('chromium'); // Chrome binary for Render

async function fetchAttendance(username, password) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: chromium.path,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage"
      ],
      timeout: 60000
    });

    const page = await browser.newPage();

    // --- Login ---
    await page.goto('https://samvidha.iare.ac.in/', { waitUntil: 'networkidle2', timeout: 60000 });
    await page.type('input[name="txt_uname"]', username, { delay: 30 });
    await page.type('input[name="txt_pwd"]', password, { delay: 30 });
    await Promise.all([
      page.click('#but_submit'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 40000 })
    ]);

    // --- Academic Attendance ---
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

    const academicWithTargets = academicAttendance.map(sub => ({
      ...sub,
      classesToAttendFor75: classesToReachTarget(sub.attended, sub.total),
      classesCanBunk: classesCanBunk(sub.attended, sub.total)
    }));

    // --- Biometric Attendance (reuse same page) ---
    await page.goto('https://samvidha.iare.ac.in/home?action=std_bio', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('table tbody tr', { timeout: 15000 });

    const biometricAttendance = await page.$$eval('table tbody tr', rows => {
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

    return { academicWithTargets, biometricAttendance };

  } catch (err) {
    console.error("Puppeteer error:", err);
    throw err;
  } finally {
    if (browser) await browser.close();
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

module.exports = fetchAttendance;
