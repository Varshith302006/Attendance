const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { launchBrowser, login, fetchAcademic, fetchBiometric } = require("./fetchAttendance");

const app = express();
app.use(cors({ origin: "https://frontend-attendance-steel.vercel.app" }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- Route: fetch sequentially ---
app.post("/get-attendance", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, error: "Username and password required" });

  let browser, page;
  try {
    ({ browser, page } = await launchBrowser());
    await login(page, username, password);

    // --- Step 1: Academic Attendance ---
    const academicWithTargets = await fetchAcademic(page);
    // Send partial response immediately
    res.write(JSON.stringify({ step: "academic", data: academicWithTargets }) + "\n");

    // --- Step 2: Biometric Attendance ---
    const biometricAttendance = await fetchBiometric(page);
    res.write(JSON.stringify({ step: "biometric", data: biometricAttendance }) + "\n");

    res.end(); // close response after both
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Server running ✅"));
