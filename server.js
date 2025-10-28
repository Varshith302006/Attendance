const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { initBrowser, login, fetchAcademic, fetchBiometric } = require("./fetchAttendance");

const app = express();
app.use(cors({ origin: "https://attendancedashboar.vercel.app" }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- Supabase setup ---
const supabaseUrl = "https://ywsqpuvraddaimlbiuds.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3c3FwdXZyYWRkYWltbGJpdWRzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA4MjMzMDgsImV4cCI6MjA3NjM5OTMwOH0.UqkzzWM7nRvgtNdvRy63LLN-UGv-zeYYx6tRYD5zxdY";
const supabase = createClient(supabaseUrl, supabaseKey);

app.get("/run-cron", async (req, res) => {
  try {
    console.log("Manual cron started at:", new Date().toLocaleString());

    // Example — call your existing attendance fetch logic
    await initBrowser();
    await login("24951A05DF", "password"); // Later we will make it dynamic via DB
    await fetchAcademic();
    await fetchBiometric();

    console.log("Manual cron completed.");
    res.json({ success: true, message: "Attendance fetched successfully" });
  } catch (error) {
    console.error("Cron failed:", error);
    res.status(500).json({ success: false, message: "Cron failed", error });
  }
});

app.post("/get-attendance", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ success: false, error: "Username and password required" });

  try {
    const { browser, page } = await initBrowser(); // 🚀 Always ready (persistent)

    await login(page, username, password);

    const academicWithTargets = await fetchAcademic(page);
    res.write(JSON.stringify({ step: "academic", data: academicWithTargets }) + "\n");

    const biometricAttendance = await fetchBiometric(page);
    res.write(JSON.stringify({ step: "biometric", data: biometricAttendance }) + "\n");

    res.end();

    const now = new Date().toISOString();

    await supabase.from("student_credentials")
      .upsert([{ username, password, fetched_at: now }], { onConflict: ["username"] });

    await supabase.from("site_visits").insert([{ username, visited_at: now }]);

    // ✅ RELOAD ONLY — back to login page immediately
    await page.goto("https://samvidha.iare.ac.in/", { waitUntil: "networkidle0" });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Today's logins ---
app.get("/today-logins", async (req, res) => {
  try {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();   endOfDay.setHours(23, 59, 59, 999);

    const { count } = await supabase
      .from("site_visits")
      .select("id", { count: "exact", head: true })
      .gte("visited_at", startOfDay.toISOString())
      .lte("visited_at", endOfDay.toISOString());

    res.json({ today_logins: count });
  } catch {
    res.status(500).json({ today_logins: 0 });
  }
});

app.listen(process.env.PORT || 3000, () => {});




>>>>>>> c3318355dc39e6f26b82f133618b932ec35ec6d0
