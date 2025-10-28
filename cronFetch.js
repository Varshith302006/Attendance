// cronFetch.js
// Run: `node cronFetch.js` (server must be running / Node must be available).
// Make sure you installed node-cron: `npm i node-cron`

const cron = require("node-cron");
const puppeteer = require("puppeteer-core");
const chromium = require("chromium");
const { createClient } = require("@supabase/supabase-js");
const { initBrowser, login, fetchAcademic, fetchBiometric } = require("./fetchAttendance");

// --- Supabase (move to env vars in production!) ---
const SUPABASE_URL = process.env.SUPABASE_URL || "https://ywsqpuvraddaimlbiuds.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3c3FwdXZyYWRkYWltbGJpdWRzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA4MjMzMDgsImV4cCI6MjA3NjM5OTMwOH0.UqkzzWM7nRvgtNdvRy63LLN-UGv-zeYYx6tRYD5zxdY";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- Small helper delay ---
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- Cron schedule: 20 16 * * *  -> 16:20 daily (server timezone overridden by 'timezone') ---
cron.schedule("20 16 * * *", async () => {
  console.log(`[${new Date().toISOString()}] Starting daily attendance fetch (cron)`);

  // 1) pull all users
  let { data: users, error: fetchErr } = await supabase
    .from("student_credentials")
    .select("*");

  if (fetchErr) {
    console.error("Failed to fetch users from Supabase:", fetchErr);
    return;
  }
  if (!users || users.length === 0) {
    console.log("No users found in student_credentials.");
    return;
  }

  // 2) ensure browser is up (we use your initBrowser which reuses browser/page)
  let browserObj;
  try {
    browserObj = await initBrowser(); // uses your fetchAttendance.initBrowser
  } catch (err) {
    console.error("Failed to init browser:", err);
    return;
  }
  const { browser, page } = browserObj;

  // 3) loop users sequentially
  for (const user of users) {
    const nowISO = new Date().toISOString();
    if (!user.username || !user.password) {
      console.warn(`Skipping user id=${user.id} (missing credentials)`);
      // update fetched_at so you know it's been processed (optional)
      await supabase.from("student_credentials").update({ fetched_at: nowISO }).eq("id", user.id);
      continue;
    }

    console.log(`Processing id=${user.id} username=${user.username}`);
    try {
      // navigate back to home/login page to ensure fresh state
      try {
        await page.goto("https://samvidha.iare.ac.in/", { waitUntil: "networkidle0", timeout: 45000 });
      } catch (e) {
        console.warn("Warning: homepage navigation failed; attempting to continue.", e.message);
      }

      // login + fetch
      await login(page, user.username, user.password);

      // fetch academic and biometric (these functions are from your fetchAttendance.js)
      const academic = await fetchAcademic(page);
      const biometric = await fetchBiometric(page);

      // store results back to Supabase (as JSON text)
      const up = {
        academic_data: JSON.stringify(academic),
        biometric_data: JSON.stringify(biometric),
        fetched_at: nowISO
      };

      const { error: updateErr } = await supabase
        .from("student_credentials")
        .update(up)
        .eq("id", user.id);

      if (updateErr) {
        console.error(`Supabase update failed for id=${user.id}:`, updateErr);
      } else {
        console.log(`Saved attendance for id=${user.id}`);
      }

      // return to homepage for next iteration (also used in your original flow)
      try {
        await page.goto("https://samvidha.iare.ac.in/", { waitUntil: "networkidle0", timeout: 30000 });
      } catch (e) {
        // still continue
      }

    } catch (err) {
      console.error(`Error processing id=${user.id} username=${user.username}:`, err.message);

      // store error object in academic_data so you can inspect failures
      const errPayload = {
        error: err.message,
        at: new Date().toISOString()
      };

      try {
        await supabase
          .from("student_credentials")
          .update({
            academic_data: JSON.stringify(errPayload),
            biometric_data: JSON.stringify({}), // clear biometric on error
            fetched_at: new Date().toISOString()
          })
          .eq("id", user.id);
      } catch (e) {
        console.error("Failed to write error to Supabase for id=", user.id, e.message);
      }
    }

    // small polite delay between users — reduce chance of rate-limits/blocks
    await wait(2000);
  } // end users loop

  console.log(`[${new Date().toISOString()}] Daily attendance fetch finished.`);

}, {
  timezone: "Asia/Kolkata"
});

// Keep process alive (if you run this file directly)
console.log("Cron worker scheduled (4:20 PM IST). Process will keep running to trigger cron.");
