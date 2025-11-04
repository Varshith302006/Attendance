const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { initBrowser, login, fetchAcademic, fetchBiometric } = require("./fetchAttendance");
const fs = require('fs');
const app = express();
app.use(cors({
  origin: [
    "https://attendancedashboar.vercel.app", // your production frontend
    "http://localhost:3000"                  // for local testing
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true, // 👈 important if you ever send cookies or tokens
}));

// ✅ Handle preflight requests (Render requires this!)
app.options("*", cors());

// ✅ Body parsers
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- Supabase setup ---
const supabaseUrl = "https://ywsqpuvraddaimlbiuds.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3c3FwdXZyYWRkYWltbGJpdWRzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA4MjMzMDgsImV4cCI6MjA3NjM5OTMwOH0.UqkzzWM7nRvgtNdvRy63LLN-UGv-zeYYx6tRYD5zxdY";
const supabase = createClient(supabaseUrl, supabaseKey);
const LOG_FILE = './cron-job.log';
function initLogFile() {
  fs.writeFileSync(LOG_FILE, `=== CRON Run: ${new Date().toISOString()} ===\n`);
}

function logEvent(event, details = {}) {
  const entry = { time: new Date().toISOString(), event, ...details };
  const line = JSON.stringify(entry);
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}


app.post("/run-selected", async (req, res) => {
  const { usernames } = req.body;

  if (!Array.isArray(usernames) || usernames.length === 0) {
    return res.status(400).json({ success: false, message: "Usernames must be a non-empty array" });
  }

  const start = Date.now();
  initLogFile();

  try {
    const { data: users, error: fetchErr } = await supabase
      .from("student_credentials")
      .select("Id, username, password")
      .in('username', usernames);

    if (fetchErr) {
      logEvent('fetch-users-error', { error: fetchErr.message });
      throw fetchErr;
    }

    if (!users || users.length === 0) {
      logEvent('no-users');
      return res.json({ success: true, message: "No students to process", processed: 0 });
    }

    const wait = ms => new Promise(r => setTimeout(r, ms));
    const { browser } = await initBrowser();

    let processed = 0;
    let succeeded = 0;
    let skipped = 0;

    logEvent('selected-cron-start', { user_count: users.length });

    for (const user of users) {
      processed++;
      const page = await browser.newPage();
      logEvent('user-start', { username: user.username });

      if (!user.username || !user.password) {
        skipped++;
        logEvent('user-skipped', { username: user.username, reason: 'missing credentials' });
        await supabase
          .from("student_credentials")
          .update({ fetched_at: new Date().toISOString() })
          .eq("Id", user.Id)
          .catch(() => {});
        await wait(3000);
        logEvent('user-end', { username: user.username, status: 'skipped' });
        await page.close();
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
          } catch (gotoErr) {
            logEvent('goto-error', { username: user.username, attempt });
          }

          await login(page, user.username, user.password);

          const academic = await fetchAcademic(page);
          const biometric = await fetchBiometric(page);

          await supabase
            .from("student_credentials")
            .update({
              academic_data: academic,
              biometric_data: biometric,
              fetched_at: new Date().toISOString(),
            })
            .eq("Id", user.Id);

          logEvent('user-success', { username: user.username });
          ok = true;
          succeeded++;
          break;
        } catch (err) {
          if (attempt === 2) {
            logEvent('user-failed', { username: user.username, attempt, error: err.message });
            skipped++;
          } else {
            logEvent('user-retry', { username: user.username, attempt, error: err.message });
            await wait(3000);
          }
        }
      }

      await page.close();
      logEvent('user-end', { username: user.username, status: ok ? 'success' : 'failed' });
      await wait(3000);
    }

    const elapsedMs = Date.now() - start;
    logEvent('selected-cron-complete', {
      processed,
      succeeded,
      skipped,
      time_seconds: Math.round(elapsedMs / 1000),
    });

    return res.json({
      success: true,
      message: "Completed",
      processed,
      succeeded,
      skipped,
      time_seconds: Math.round(elapsedMs / 1000),
    });
  } catch (err) {
    logEvent('selected-cron-fatal', { error: err.message });
    return res.status(500).json({ success: false, message: err.message || "Internal error" });
  }
});

app.get("/run-cron", async (req, res) => {
  const start = Date.now();
  initLogFile(); // Clear log for each run

  try {
    // 1) Fetch users
    const { data: users, error: fetchErr } = await supabase
      .from("student_credentials")
      .select("Id, username, password");

    if (fetchErr) {
      logEvent('fetch-users-error', { error: fetchErr.message });
      throw fetchErr;
    }
    if (!users || users.length === 0) {
      logEvent('no-users');
      return res.json({ success: true, message: "No students to process", processed: 0 });
    }

    const wait = ms => new Promise(r => setTimeout(r, ms));
    const { browser, page } = await initBrowser();

    let processed = 0;
    let succeeded = 0;
    let skipped = 0;

    logEvent('cron-start', { user_count: users.length });

    for (const user of users) {
      processed++;
      logEvent('user-start', { username: user.username });

      // skip if missing creds
      if (!user.username || !user.password) {
        skipped++;
        logEvent('user-skipped', { username: user.username, reason: 'missing credentials' });
        await supabase
          .from("student_credentials")
          .update({ fetched_at: new Date().toISOString() })
          .eq("Id", user.Id)
          .catch(() => {});
        await wait(3000);
        logEvent('user-end', { username: user.username, status: 'skipped' });
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
          } catch (gotoErr) {
            logEvent('goto-error', { username: user.username, attempt });
          }

          await login(page, user.username, user.password);

          const academic = await fetchAcademic(page);
          const biometric = await fetchBiometric(page);

          await supabase
            .from("student_credentials")
            .update({
              academic_data: academic,
              biometric_data: biometric,
              fetched_at: new Date().toISOString(),
            })
            .eq("Id", user.Id);

          logEvent('user-success', { username: user.username });
          ok = true;
          succeeded++;
          break;
        } catch (err) {
          if (attempt === 2) {
            logEvent('user-failed', { username: user.username, attempt, error: err.message });
            skipped++;
          } else {
            logEvent('user-retry', { username: user.username, attempt, error: err.message });
            await wait(3000);
          }
        }
      }

      logEvent('user-end', { username: user.username, status: ok ? 'success' : 'failed' });
      await wait(3000);
    }

    await browser.close();

    const elapsedMs = Date.now() - start;
    logEvent('cron-complete', {
      processed,
      succeeded,
      skipped,
      time_seconds: Math.round(elapsedMs / 1000),
    });

    return res.json({
      success: true,
      message: "Completed",
      processed,
      succeeded,
      skipped,
      time_seconds: Math.round(elapsedMs / 1000),
    });
  } catch (err) {
    logEvent('cron-fatal', { error: err.message });
    return res.status(500).json({ success: false, message: err.message || "Internal error" });
  }
});



app.post("/get-attendance", async (req, res) => {
  const { username, password } = req.body || {};

  // Set content type for streaming JSON lines
  res.setHeader('Content-Type', 'application/json');

  if (!username || !password) {
    res.write(JSON.stringify({ step: "error", data: { error: "username and password required" } }) + "\n");
    return res.end();
  }

  try {
    // 1) Look up user in Supabase
    const { data: existing, error: selErr } = await supabase
      .from("student_credentials")
      .select("Id, username, password, academic_data, biometric_data, fetched_at")
      .eq("username", username)
      .maybeSingle();

    if (selErr) throw selErr;

    const now = new Date();

    // 2) If user exists, check cache validity (< 24 hours) and presence of both datasets
    if (existing) {
      const hasAcademic = existing.academic_data !== null && existing.academic_data !== undefined;
      const hasBiometric = existing.biometric_data !== null && existing.biometric_data !== undefined;
      const fetchedAt = existing.fetched_at ? new Date(existing.fetched_at) : null;
      const ageMs = fetchedAt ? (now - fetchedAt) : Infinity;
      const isFresh = fetchedAt && ageMs < 24 * 60 * 60 * 1000; // < 24 hours

      // Return cache only if password matches AND data present AND fresh
     if (existing.password === password && hasAcademic && hasBiometric && isFresh) {
        // Record site visit
        await supabase
          .from("site_visits")
          .insert([{ username, visited_at: new Date().toISOString() }]);
      
        res.write(JSON.stringify({ step: "academic", data: existing.academic_data }) + "\n");
        res.write(JSON.stringify({ step: "biometric", data: existing.biometric_data }) + "\n");
        return res.end();
      }

    }

    // 3) Need to do live fetch (cache missing/expired or password mismatch or user doesn't exist)
    let academic = null;
    let biometric = null;
    try {
      const { browser, page } = await initBrowser();

      // best-effort navigate to reset state
      try { await page.goto("https://samvidha.iare.ac.in/", { waitUntil: "networkidle2", timeout: 45000 }); } catch (e) {}

      // attempt login - may throw on bad credentials or site block
      await login(page, username, password);

      // fetch attendance
      academic = await fetchAcademic(page);
      biometric = await fetchBiometric(page);

      // No need to forcibly close browser if your initBrowser is designed for reuse.
    } catch (liveErr) {
      // If any step fails, respond as error immediately
      res.write(JSON.stringify({ step: "error", data: { error: "Invalid credentials or site blocked (login failed)" } }) + "\n");
      return res.end();
    }

    // 4) Persist results to Supabase (JSONB fields) - do not overwrite password for existing users
    const payload = {
      academic_data: academic ?? null,
      biometric_data: biometric ?? null,
      fetched_at: new Date().toISOString()
    };

    if (existing) {
      // Update existing row (do NOT change password)
      await supabase
        .from("student_credentials")
        .update(payload)
        .eq("Id", existing.Id);
    } else {
      // Insert new row and save password
      const insertRow = {
        username,
        password,
        academic_data: payload.academic_data,
        biometric_data: payload.biometric_data,
        fetched_at: payload.fetched_at
      };
      await supabase.from("student_credentials").insert([insertRow]);
    }

       // Record site visit
    await supabase
      .from("site_visits")
      .insert([{ username, visited_at: new Date().toISOString() }]);
    
    // 5) Stream fresh data to frontend (each as its own JSON object)
    res.write(JSON.stringify({ step: "academic", data: academic }) + "\n");
    res.write(JSON.stringify({ step: "biometric", data: biometric }) + "\n");
    res.end();


  } catch (err) {
    res.write(JSON.stringify({ step: "error", data: { error: err?.message || "Internal server error" } }) + "\n");
    res.end();
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

