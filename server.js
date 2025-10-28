const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { initBrowser, login, fetchAcademic, fetchBiometric } = require("./fetchAttendance");

const app = express();
app.use(cors({
  origin: "https://attendancedashboar.vercel.app", // your frontend
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- Supabase setup ---
const supabaseUrl = "https://ywsqpuvraddaimlbiuds.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3c3FwdXZyYWRkYWltbGJpdWRzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA4MjMzMDgsImV4cCI6MjA3NjM5OTMwOH0.UqkzzWM7nRvgtNdvRy63LLN-UGv-zeYYx6tRYD5zxdY";
const supabase = createClient(supabaseUrl, supabaseKey);

// Silent safe /run-cron endpoint — ONE-BY-ONE queue, 3s delay, retry once, SKIP failures
app.get("/run-cron", async (req, res) => {
  const start = Date.now();

  try {
    // 1) fetch users
    const { data: users, error: fetchErr } = await supabase
      .from("student_credentials")
      .select("Id,username, password");

    if (fetchErr) throw fetchErr;
    if (!users || users.length === 0) {
      console.log(`[run-cron] No users found.`);
      return res.json({ success: true, message: "No students to process", processed: 0 });
    }

    // helper
    const wait = ms => new Promise(r => setTimeout(r, ms));

    // 2) init browser/page once (uses your existing initBrowser)
    const { browser, page } = await initBrowser();

    let processed = 0;
    let succeeded = 0;
    let skipped = 0;

    // 3) process sequentially
    for (const user of users) {
      processed++;

      // skip if missing credentials
      if (!user.username || !user.password) {
        skipped++;
        await supabase
          .from("student_credentials")
          .update({ fetched_at: new Date().toISOString() })
          .eq("id", user.id)
          .then(() => {}) // ignore errors updating fetched_at for missing creds
          .catch(() => {});
        // polite wait
        await wait(3000);
        continue;
      }

      // try up to 2 attempts
      let ok = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          // ensure we're at homepage / login page to start fresh
          try {
            await page.goto("https://samvidha.iare.ac.in/", { waitUntil: "networkidle2", timeout: 45000 });
          } catch (e) {
            // continue; page.goto may fail sometimes; still try login
          }

          // use your login/fetch functions (they operate on `page`)
          await login(page, user.username, user.password);

          // fetch data
          const academic = await fetchAcademic(page);
          const biometric = await fetchBiometric(page);

          // update supabase only on success
          await supabase
            .from("student_credentials")
            .update({
              academic_data: JSON.stringify(academic),
              biometric_data: JSON.stringify(biometric),
              fetched_at: new Date().toISOString()
            })
            .eq("id", user.id);

          ok = true;
          succeeded++;
          break; // success — exit retry loop
        } catch (err) {
          // on last attempt, we skip updating this user
          if (attempt === 2) {
            skipped++;
            // do NOT write error to DB (SKIP as requested)
          } else {
            // small backoff before retry
            await wait(3000);
          }
        }
      } // end retry loop

      // polite delay between users
      await wait(3000);
    } // end users loop

    const elapsedMs = Date.now() - start;
    console.log(`[run-cron] Completed. processed=${processed}, succeeded=${succeeded}, skipped=${skipped}, time=${Math.round(elapsedMs/1000)}s`);

    return res.json({
      success: true,
      message: "Completed",
      processed,
      succeeded,
      skipped,
      time_seconds: Math.round(elapsedMs/1000)
    });

  } catch (err) {
    console.error(`[run-cron] Fatal error:`, err.message || err);
    return res.status(500).json({ success: false, message: err.message || "Internal error" });
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

