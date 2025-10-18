const express = require("express");
const bodyParser = require("body-parser");
const puppeteer = require("puppeteer-core");
const chromium = require("chromium");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

// --- CORS: allow your Vercel frontend ---
app.use(cors({
  origin: "https://frontend-attendance-steel.vercel.app",
  methods: ["GET", "POST"]
}));

// --- Middleware ---
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// --- Puppeteer cache ---
process.env.PUPPETEER_CACHE_DIR = "/opt/render/.cache/puppeteer";

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

// --- Main scraper ---
async function fetchAttendance(username, password) {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium.path,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--disable-dev-shm-usage"]
  });

  const page = await browser.newPage();

  // Login
  await page.goto("https://samvidha.iare.ac.in/", { waitUntil: "domcontentloaded" });
  await page.type('input[name="txt_uname"]', username, { delay: 50 });
  await page.type('input[name="txt_pwd"]', password, { delay: 50 });
  await page.click("#but_submit");
  await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 });

  // Academic Attendance
  await page.evaluate(() => document.querySelector('a[href*="action=stud_att_STD"]').click());
  await page.waitForSelector("table tbody tr", { timeout: 20000 });

  const academicAttendance = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("table tbody tr"));
    return rows
      .map(row => {
        const cols = row.querySelectorAll("td");
        if (cols.length >= 8) {
          return {
            courseCode: cols[1].innerText.trim(),
            subject: cols[2].innerText.trim(),
            total: parseInt(cols[5].innerText.trim()),
            attended: parseInt(cols[6].innerText.trim()),
            percentage: parseFloat(cols[7].innerText.trim())
          };
        }
      })
      .filter(Boolean);
  });

  const academicWithTargets = academicAttendance.map(sub => ({
    ...sub,
    classesToAttendFor75: classesToReachTarget(sub.attended, sub.total, 75),
    classesCanBunk: classesCanBunk(sub.attended, sub.total, 75)
  }));

  // Biometric Attendance
  await page.goto("https://samvidha.iare.ac.in/home?action=std_bio", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("table tbody tr", { timeout: 20000 });

  const biometricAttendance = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("table tbody tr"));
    const totalDays = rows.length - 1;
    const presentCount = rows.filter(row => {
      const cols = row.querySelectorAll("td");
      return Array.from(cols).some(td => td.innerText.trim().toLowerCase() === "present");
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

// --- Routes ---
app.post("/get-attendance", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: "Username and password required" });
  }

  try {
    const data = await fetchAttendance(username, password);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
