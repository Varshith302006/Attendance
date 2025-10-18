const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { fetchAcademic, fetchBiometric } = require("./fetchAttendance");

const app = express();

// Middleware
app.use(cors({ origin: "https://frontend-attendance-steel.vercel.app" }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- Routes ---
// 1️⃣ Academic Attendance
app.post("/get-academic", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, error: "Username and password required" });

  try {
    const academicWithTargets = await fetchAcademic(username, password);
    res.json({ success: true, data: academicWithTargets });
  } catch (err) {
    console.error("Academic error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2️⃣ Biometric Attendance
app.post("/get-biometric", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, error: "Username and password required" });

  try {
    const biometricAttendance = await fetchBiometric(username, password);
    res.json({ success: true, data: biometricAttendance });
  } catch (err) {
    console.error("Biometric error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Health check
app.get("/", (req, res) => res.send("Attendance API running ✅"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
