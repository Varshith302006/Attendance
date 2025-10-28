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
    // 1) Try to find existing user by username
    const { data: existing, error: selErr } = await supabase
      .from("student_credentials")
      .select("Id, username, password, academic_data, biometric_data, fetched_at")
      .eq("username", username)
      .maybeSingle();

    if (selErr) throw selErr;

    const now = new Date();

    // 2) Check whether we can return cached data:
    if (existing) {
      const hasAcademic = existing.academic_data !== null && existing.academic_data !== undefined;
      const hasBiometric = existing.biometric_data !== null && existing.biometric_data !== undefined;
      const fetchedAt = existing.fetched_at ? new Date(existing.fetched_at) : null;
      const ageMs = fetchedAt ? (now - fetchedAt) : Infinity;
      const isFresh = fetchedAt && ageMs < 24 * 60 * 60 * 1000; // < 24 hours

      // If stored password matches the provided password and both data exist and fresh -> return cache
      if (existing.password === password && hasAcademic && hasBiometric && isFresh) {
        return res.json({
          success: true,
          source: "supabase",
          academic: existing.academic_data,
          biometric: existing.biometric_data,
          fetched_at: existing.fetched_at
        });
      }
    }

    // 3) Need to fetch live (either not found, stale/missing, or password didn't match cache conditions)
    // Attempt a live login + fetch. If login fails, return 401 and do not write to DB.
    let academic = null;
    let biometric = null;

    try {
      // Use the helper functions you already have in ./fetchAttendance
      // Ensure browser/page is initialized by your initBrowser (it will reuse a persistent browser if implemented)
      const { browser, page } = await initBrowser();

      // navigate to home if needed (some sites require this to avoid stale state)
      try { await page.goto("https://samvidha.iare.ac.in/", { waitUntil: "networkidle2", timeout: 45000 }); } catch(e) {}

      // Perform login with provided credentials (may throw on bad creds or CAPTCHA)
      await login(page, username, password);

      // fetch the two types of attendance (these should return JS objects / arrays)
      academic = await fetchAcademic(page);
      biometric = await fetchBiometric(page);

      // NOTE: we DO NOT close browser here — your initBrowser may reuse it for performance
    } catch (liveErr) {
      // Live fetch/login failed -> treat as invalid credentials or blocking
      console.error("[/get-attendance] live fetch failed:", liveErr.message || liveErr);
      return res.status(401).json({ success: false, message: "Invalid credentials or site blocked (login failed)", detail: liveErr.message || null });
    }

    // 4) Save results to Supabase:
    const payload = {
      academic_data: academic ?? null,   // store as JSONB
      biometric_data: biometric ?? null,
      fetched_at: new Date().toISOString()
    };

    if (existing) {
      // Update existing row — DO NOT overwrite password
      await supabase
        .from("student_credentials")
        .update(payload)
        .eq("Id", existing.Id);
    } else {
      // Insert new user row — include password (user asked to save)
      const insertRow = {
        username,
        password,              // saved only on insert
        academic_data: payload.academic_data,
        biometric_data: payload.biometric_data,
        fetched_at: payload.fetched_at
      };
      await supabase.from("student_credentials").insert([insertRow]);
    }

    // 5) Return live data to caller
    return res.json({
      success: true,
      source: "live",
      academic,
      biometric,
      fetched_at: payload.fetched_at
    });

  } catch (err) {
    console.error("[/get-attendance] error:", err);
    return res.status(500).json({ success: false, message: err.message || "Internal server error" });
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

