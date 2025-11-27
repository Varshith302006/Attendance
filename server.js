// =========================
// QUEUE SYSTEM (OPTION B)
// =========================

const queue = [];
let isProcessing = false;

// delay for Samvidha between calls (IMPORTANT)
const SAMVIDHA_DELAY = 300; // 800ms recommended (safe)

// Helper: sleep/pause
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Add job to queue
function addToQueue(task) {
  queue.push(task);
  processQueue();
}

// Process queue (one at a time)
async function processQueue() {
  if (isProcessing) return;
  if (queue.length === 0) return;

  isProcessing = true;
  const task = queue.shift();

  try {
    await task(); // run job
  } catch (err) {
    console.error("Queue task error:", err);
  }

  await wait(SAMVIDHA_DELAY);
  isProcessing = false;

  // Continue next job
  processQueue();
}

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { initBrowser, login, fetchAcademic, fetchBiometric, fetchLatestAttendance} = require("./fetchAttendance");
const fs = require('fs');

const app = express();

// Enable CORS
app.use(cors({
  origin: [
    "https://attendancedashboar.vercel.app",
    "http://localhost:3000"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
}));

app.options("*", cors());

// Body parsers
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Supabase setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Logging
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

// --------------------------------------------------------------
// 🔥 1. FETCH SELECTED USERS (CRON-LIKE)
// --------------------------------------------------------------
app.post("/run-selected", async (req, res) => {
  const { usernames } = req.body;

  if (!Array.isArray(usernames) || usernames.length === 0) {
    return res.status(400).json({ success: false, message: "Usernames must be a non-empty array" });
  }

  const start = Date.now();
  initLogFile();

  try {
    const { data: users, error } = await supabase
      .from("student_credentials")
      .select("Id, username, password")
      .in("username", usernames);

    if (error) throw error;

    if (!users || users.length === 0) {
      return res.json({ success: true, message: "No matching users", processed: 0 });
    }

    let processed = 0, succeeded = 0, skipped = 0;

    for (const user of users) {
      processed++;

      if (!user.username || !user.password) {
        skipped++;
        continue;
      }

      try {
        // LOGIN (returns cookies)
        const cookies = await login(null, user.username, user.password);

        // FETCH ACADEMIC + BIOMETRIC
        // const academic = await fetchAcademic(cookies);
        // const biometric = await fetchBiometric(cookies);
        const [academic, biometric] = await Promise.all([
          fetchAcademic(cookies),
          fetchBiometric(cookies)
        ]);


        // SAVE TO DB
        await supabase
          .from("student_credentials")
          .update({
            academic_data: academic,
            biometric_data: biometric,
            fetched_at: new Date().toISOString(),
          })
          .eq("Id", user.Id);

        succeeded++;

      } catch (err) {
        skipped++;
      }
    }

    const elapsed = Math.round((Date.now() - start) / 1000);

    return res.json({ success: true, processed, succeeded, skipped, time_seconds: elapsed });

  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// --------------------------------------------------------------
// 🔥 2. AUTO CRON (FETCH ALL USERS)
// --------------------------------------------------------------
app.get("/run-cron", async (req, res) => {
  const start = Date.now();
  initLogFile();

  try {
    const { data: users, error } = await supabase
      .from("student_credentials")
      .select("Id, username, password");

    if (error) throw error;

    let processed = 0, succeeded = 0, skipped = 0;

    for (const user of users) {
      processed++;

      if (!user.username || !user.password) {
        skipped++;
        continue;
      }

      try {
        const cookies = await login(null, user.username, user.password);
        const academic = await fetchAcademic(cookies);
        const biometric = await fetchBiometric(cookies);

        await supabase
          .from("student_credentials")
          .update({
            academic_data: academic,
            biometric_data: biometric,
            fetched_at: new Date().toISOString(),
          })
          .eq("Id", user.Id);

        succeeded++;
      } catch {
        skipped++;
      }
    }

    const elapsed = Math.round((Date.now() - start) / 1000);

    return res.json({ success: true, processed, succeeded, skipped, time_seconds: elapsed });

  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// --------------------------------------------------------------
// 🔥 3. FETCH SINGLE USER LIVE (MAIN API USED BY FRONTEND)
// --------------------------------------------------------------
app.post("/get-attendance", async (req, res) => {
  const { username, password } = req.body || {};

  res.setHeader("Content-Type", "application/json");

  if (!username || !password) {
    res.write(JSON.stringify({ step: "error", data: { error: "Missing username/password" } }) + "\n");
    return res.end();
  }

  // Put the job in queue
  addToQueue(async () => {
    try {
      // STEP 1: Check existing data
      const { data: existing } = await supabase
        .from("student_credentials")
        .select("*")
        .eq("username", username)
        .maybeSingle();

      const now = Date.now();

      const isFresh =
        existing &&
        existing.password === password &&
        existing.fetched_at &&
        now - new Date(existing.fetched_at).getTime() < 0 * 60 * 1000;

      if (isFresh) {
        res.write(JSON.stringify({ step: "academic", data: existing.academic_data }) + "\n");
        res.write(JSON.stringify({ step: "biometric", data: existing.biometric_data }) + "\n");
        return res.end();
      }

      // STEP 2: LIVE SCRAPE (safe because queue handles it)
      let cookies;
      try {
        cookies = await login(null, username, password);
      } catch {
        res.write(JSON.stringify({ step: "error", data: { error: "Invalid Credentials" } }) + "\n");
        return res.end();
      }

      const academic = await fetchAcademic(cookies);
      const biometric = await fetchBiometric(cookies);
      // const latest = await fetchLatestAttendance(cookies);

      // ❗ VALIDATE RETURNED DATA — do NOT save if invalid
      const invalidData =
        !academic || !Array.isArray(academic) || academic.length === 0 ||
        !biometric || typeof biometric !== "object";
      
      if (invalidData) {
        res.write(
          JSON.stringify({
            step: "error",
            data: { error: "No attendance data found. Not saving to database." }
          }) + "\n"
        );
        return res.end(); 
      }
      // STEP 3: Write to DB
      if (existing) {
        await supabase
          .from("student_credentials")
          .update({
            academic_data: academic,
            biometric_data: biometric,
            fetched_at: new Date().toISOString()
          })
          .eq("Id", existing.Id);
      } else {
        await supabase.from("student_credentials").insert([
          {
            username,
            password,
            academic_data: academic,
            biometric_data: biometric,
            fetched_at: new Date().toISOString()
          }
        ]);
      }
      // Insert site visit
      if(username!="24951A05DX"){
        await supabase
          .from("site_visits")
          .insert([{ username, visited_at: new Date().toISOString() }]);
      }
     
      // STEP 4: Respond to frontend
      res.write(JSON.stringify({ step: "academic", data: academic }) + "\n");
      res.write(JSON.stringify({ step: "biometric", data: biometric }) + "\n");
      // res.write(JSON.stringify({ step: "latest", data: latest }) + "\n");
      res.end();
    } catch (err) {
      res.write(JSON.stringify({ step: "error", data: { error: err.message } }) + "\n");
      res.end();
    }
  });
});
app.post("/get-latest", async (req, res) => {
  const { username, password } = req.body || {};

  res.setHeader("Content-Type", "application/json");

  if (!username || !password) {
    return res.json({ success: false, error: "Missing credentials" });
  }

  try {
    // Login
    const cookies = await login(null, username, password);

    // Fetch latest attendance
    const latest = await fetchLatestAttendance(cookies);

    return res.json({ success: true, latest });
  } catch (err) {
    return res.json({ success: false, error: err.message });
  }
});


// --------------------------------------------------------------
// 🔥 4. TRACK VISITS
// --------------------------------------------------------------
app.get("/today-logins", async (req, res) => {
  try {
    const startDay = new Date(); startDay.setHours(0,0,0,0);
    const endDay   = new Date(); endDay.setHours(23,59,59,999);

    const { count } = await supabase
      .from("site_visits")
      .select("id", { count: "exact", head: true })
      .gte("visited_at", startDay.toISOString())
      .lte("visited_at", endDay.toISOString());

    res.json({ today_logins: count });
  } catch {
    res.json({ today_logins: 0 });
  }
});


// --------------------------------------------------------------
// START SERVER
// --------------------------------------------------------------
app.listen(process.env.PORT || 3000, () => {
  console.log("Server running…");
});
