const { Cluster } = require('puppeteer-cluster');
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
// Only import these 3 from fetchAttendance.js (not launchBrowser)
const { login, fetchAcademic, fetchBiometric } = require("./fetchAttendance");

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

let cluster;

(async () => {
  cluster = await Cluster.launch({
    concurrency: Cluster.CONCURRENCY_PAGE,
    maxConcurrency: 5,
    puppeteerOptions: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    }
  });

  // Cluster task logic using provided Puppeteer 'page'
  cluster.task(async ({ page, data }) => {
    const { username, password } = data;
    await login(page, username, password);
    const academicWithTargets = await fetchAcademic(page);
    const biometricAttendance = await fetchBiometric(page);
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

    return {
      success: true,
      steps: [
        { step: "academic", data: academicWithTargets },
        { step: "biometric", data: biometricAttendance }
      ]
    };
  });

  // --- Route: get-attendance ---
  app.post("/get-attendance", async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ success: false, error: "Username and password required" });

    try {
      const result = await cluster.execute({ username, password });
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // --- Route: get today's login count ---
  app.get("/today-logins", async (req, res) => {
    try {
      const startOfDay = new Date();
      startOfDay.setHours(0,0,0,0);
      const endOfDay = new Date();
      endOfDay.setHours(23,59,59,999);

      const { count, error } = await supabase
        .from("site_visits")
        .select("id", { count: "exact", head: true })
        .gte("visited_at", startOfDay.toISOString())
        .lte("visited_at", endOfDay.toISOString());

      if (error) throw error;
      res.json({ today_logins: count });
    } catch (err) {
      console.error(err);
      res.status(500).json({ today_logins: 0 });
    }
  });

  // --- Start server ---
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running ✅ on port ${PORT}`));
})();
