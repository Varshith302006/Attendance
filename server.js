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
    // 1) Fetch users
    const { data: users, error: fetchErr } = await supabase
      .from("student_credentials")
      .select("Id, username, password");

    if (fetchErr) throw fetchErr;
    if (!users || users.length === 0) {
      console.log(`[run-cron] No users found.`);
      return res.json({ success: true, message: "No students to process", processed: 0 });
    }

    const wait = ms => new Promise(r => setTimeout(r, ms));
    const { browser, page } = await initBrowser();

    let processed = 0;
    let succeeded = 0;
    let skipped = 0;

    console.log(`\n===== 🕒 Starting CRON for ${users.length} students =====\n`);

    for (const user of users) {
      processed++;
      console.log(`🔄 Fetching ${user.username} ...`);

      // skip if missing creds
      if (!user.username || !user.password) {
        skipped++;
        console.log(`⚠️ Skipped ${user.username} — missing credentials`);
        await supabase
          .from("student_credentials")
          .update({ fetched_at: new Date().toISOString() })
          .eq("Id", user.Id)
          .catch(() => {});
        await wait(3000);
        console.log(`----------------------------------`);
        continue;
      }

      let ok = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          try {
            await page.goto("https://samvidha.iare.ac.in/", {
              waitUntil: "networkidle2",
              timeout: 45000,
            });
          } catch {}

          await login(page, user.username, user.password);

          const academic = await fetchAcademic(page);
          const biometric = await fetchBiometric(page);

          await supabase
            .from("student_credentials")
            .update({
              academic_data: JSON.stringify(academic),
              biometric_data: JSON.stringify(biometric),
              fetched_at: new Date().toISOString(),
            })
            .eq("Id", user.Id);

          console.log(`✅ Success — updated ${user.username}`);
          ok = true;
          succeeded++;
          break;
        } catch (err) {
          if (attempt === 2) {
            console.log(`❌ Failed ${user.username} after 2 attempts — skipped`);
            skipped++;
          } else {
            console.log(`⚠️ Attempt ${attempt} failed for ${user.username}, retrying...`);
            await wait(3000);
          }
        }
      }

      console.log(`----------------------------------`);
      await wait(3000);
    }

    await browser.close();

    const elapsedMs = Date.now() - start;
    console.log(
      `\n✅ Completed CRON. processed=${processed}, succeeded=${succeeded}, skipped=${skipped}, time=${Math.round(elapsedMs / 1000)}s`
    );

    return res.json({
      success: true,
      message: "Completed",
      processed,
      succeeded,
      skipped,
      time_seconds: Math.round(elapsedMs / 1000),
    });
  } catch (err) {
    console.error(`[run-cron] Fatal error:`, err.message || err);
    return res.status(500).json({ success: false, message: err.message || "Internal error" });
  }
});




// POST /get-attendance
app.post("/get-attendance", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, message: "username and password required" });
  }

  try {
    // 1) try to find user in Supabase
    const { data: existing, error: selErr } = await supabase
      .from("student_credentials")
      .select("Id, username, password, academic_data, biometric_data, fetched_at")
      .eq("username", username)
      .maybeSingle();

    if (selErr) throw selErr;

    const now = new Date();
    let useCache = false;
    if (existing) {
      // if stored password matches the provided one and data exists and fetched_at < 24h
      const hasAcademic = existing.academic_data !== null && existing.academic_data !== undefined;
      const hasBiometric = existing.biometric_data !== null && existing.biometric_data !== undefined;
      const fetchedAt = existing.fetched_at ? new Date(existing.fetched_at) : null;
      const ageMs = fetchedAt ? (now - fetchedAt) : Infinity;
      const isFresh = fetchedAt && ageMs < 24 * 60 * 60 * 1000; // < 24 hours

      if (existing.password === password && hasAcademic && hasBiometric && isFresh) {
        useCache = true;
      }
    }

    if (useCache && existing) {
      // Return cached data (Supabase returns JSONB as objects)
      return res.json({
        success: true,
        source: "supabase",
        academic: existing.academic_data,
        biometric: existing.biometric_data,
        fetched_at: existing.fetched_at
      });
    }

    // 2) Need to fetch live (either not found, password mismatch, missing data, or stale)
    // Choose fetch implementation dynamically:
    let academic, biometric;

    if (typeof fetchAttendance === "function") {
      // If module exports single convenience function: fetchAttendance(username, password)
      const result = await fetchAttendance(username, password);
      // Expecting result to be { academic, biometric } or similar
      if (result) {
        academic = result.academic ?? result.academic_data ?? result.academicData ?? result.academic_data;
        biometric = result.biometric ?? result.biometric_data ?? result.biometricData ?? result.biometric_data;
      }
    }

    // fallback to separate functions if fetchAttendance not present or didn't return objects
    if (!academic || !biometric) {
      // ensure browser/page is initialised by your initBrowser
      const { browser, page } = await initBrowser();
      await page.goto("https://samvidha.iare.ac.in/", { waitUntil: "networkidle2", timeout: 45000 }).catch(()=>{});
      await login(page, username, password);
      academic = await fetchAcademic(page);
      biometric = await fetchBiometric(page);
      // don't close browser here — your initBrowser may manage reuse
    }

    // 3) Update Supabase:
    const updatePayload = {
      academic_data: academic ?? null,
      biometric_data: biometric ?? null,
      fetched_at: new Date().toISOString()
    };

    if (existing) {
      // Update existing row — do NOT overwrite password
      await supabase
        .from("student_credentials")
        .update(updatePayload)
        .eq("Id", existing.Id);
    } else {
      // Insert new row — only include password if provided (and user wanted to save it)
      const insertRow = {
        username,
        fetched_at: updatePayload.fetched_at,
        academic_data: updatePayload.academic_data,
        biometric_data: updatePayload.biometric_data
      };
      if (password) insertRow.password = password;
      await supabase.from("student_credentials").insert([insertRow]);
    }

    // 4) Return live result
    return res.json({
      success: true,
      source: "live",
      academic,
      biometric,
      fetched_at: updatePayload.fetched_at
    });

  } catch (err) {
    console.error("[/get-attendance] error:", err);
    return res.status(500).json({ success: false, message: err.message || "Internal error" });
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

