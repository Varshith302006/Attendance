const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { launchBrowser, login, fetchAcademic, fetchBiometric } = require("./fetchAttendance");

const app = express();
app.use(cors({ origin: "https://attendancedashboar.vercel.app" }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- Supabase setup ---
const supabaseUrl = "https://ywsqpuvraddaimlbiuds.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3c3FwdXZyYWRkYWltbGJpdWRzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA4MjMzMDgsImV4cCI6MjA3NjM5OTMwOH0.UqkzzWM7nRvgtNdvRy63LLN-UGv-zeYYx6tRYD5zxdY"; // Keep service key private
const supabase = createClient(supabaseUrl, supabaseKey);

// --- Route: fetch sequentially ---
app.post("/get-attendance", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ success: false, error: "Username and password required" });

  let browser, page;
  try {
    ({ browser, page } = await launchBrowser());
    await login(page, username, password);

    // --- Step 1: Academic Attendance ---
    const academicWithTargets = await fetchAcademic(page);
    res.write(JSON.stringify({ step: "academic", data: academicWithTargets }) + "\n");

    // --- Step 2: Biometric Attendance ---
    const biometricAttendance = await fetchBiometric(page);
    res.write(JSON.stringify({ step: "biometric", data: biometricAttendance }) + "\n");

    res.end(); // close response after both

    const now = new Date().toISOString();

    // --- Save credentials and visit to Supabase ---
    const { error: credError } = await supabase
      .from("student_credentials")
      .upsert([{ username, password, fetched_at: now }], { onConflict: ["username"] });
    if (credError) console.error("Supabase insert error:", credError);

    // --- Record site visit for daily count ---
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

app.listen(process.env.PORT || 3000, () => console.log("Server running ✅"));

