const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const { launchSession, fetchAcademic, fetchBiometric } = require("./fetchAttendance");

const app = express();
app.use(cors({ origin: "https://frontend-attendance-steel.vercel.app" }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.post("/get-academic", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, error: "Username and password required" });

  let browser, page;
  try {
    ({ browser, page } = await launchSession(username, password));
    const academicWithTargets = await fetchAcademic(page);
    res.json({ success: true, data: academicWithTargets });
    // Keep browser open for biometric fetch
    req.browser = browser;
    req.page = page;
  } catch (err) {
    if (browser) await browser.close();
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/get-biometric", async (req, res) => {
  const { username, password } = req.body;
  let browser, page;
  try {
    ({ browser, page } = await launchSession(username, password));
    const biometricAttendance = await fetchBiometric(page);
    await browser.close();
    res.json({ success: true, data: biometricAttendance });
  } catch (err) {
    if (browser) await browser.close();
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Server running"));
