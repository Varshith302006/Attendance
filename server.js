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

// ✅ Manually triggered attendance fetch route (NO CRON)
app.get("/run-cron", async (req, res) => {
  console.log("🕒 /run-cron triggered at:", new Date().toLocaleString());

  try {
    // 1) Fetch all students from Supabase
    const { data: users, error: fetchErr } = await supabase
      .from("student_credentials")
      .select("*");

    if (fetchErr) throw fetchErr;
    if (!users || users.length === 0) {
      console.log("No users found in student_credentials.");
      return res.json({ success: false, message: "No students found" });
    }

    console.log(`📚 Found ${users.length} users.`);

    // 2) Init browser ONCE
    const { browser, page } = await initBrowser();

    // 3) Process users one by one
    for (const user of users) {
      const nowISO = new Date().toISOString();
      console.log(`🔄 Fetching attendance for ${user.username}...`);

      try {
        await page.goto("https://samvidha.iare.ac.in/", { waitUntil: "networkidle0", timeout: 45000 });
        await login(page, user.username, user.password);

        const academic = await fetchAcademic(page);
        const biometric = await fetchBiometric(page);

        // 4) Update Supabase record
        const { error: updateErr } = await supabase
          .from("student_credentials")
          .update({
            academic_data: JSON.stringify(academic),
            biometric_data: JSON.stringify(biometric),
            fetched_at: nowISO
          })
          .eq("id", user.id);

        console.log(updateErr ? `❌ Update failed for ${user.username}` : `✅ Updated ${user.username}`);
      } catch (err) {
        console.error(`Error for ${user.username}:`, err.message);
      }
    }

    console.log("✅ Attendance fetch completed for all users.");
    return res.json({ success: true, message: "Attendance fetched for all users" });

  } catch (err) {
    console.error("💥 Cron error:", err.message);
    return res.status(500).json({ success: false, message: err.message });
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
