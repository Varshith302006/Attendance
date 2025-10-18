const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fetchAttendance = require("./fetchAttendance"); // your optimized scraper

const app = express();

// --- Middleware ---
app.use(cors({ origin: "https://frontend-attendance-steel.vercel.app" }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- Simple in-memory cache (optional) ---
const attendanceCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// --- Helper to get cached or fetch ---
async function getAttendance(username, password) {
  const cacheKey = username;
  const cached = attendanceCache.get(cacheKey);

  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    return cached.data;
  }

  const data = await fetchAttendance(username, password);
  attendanceCache.set(cacheKey, { data, timestamp: Date.now() });
  return data;
}

// --- Routes ---
app.post("/get-attendance", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: "Username and password required" });
  }

  try {
    // Limit total execution to 60s
    const data = await Promise.race([
      getAttendance(username, password),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout: Portal too slow")), 60000))
    ]);
    res.json({ success: true, data });
  } catch (err) {
    console.error("Error fetching attendance:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Health check ---
app.get("/", (req, res) => {
  res.send("Attendance API running ✅");
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
