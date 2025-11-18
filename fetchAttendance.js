// fetchAttendance.js — FINAL FIXED VERSION FOR SAMVIDHA ✔✔

const axios = require("axios");
const cheerio = require("cheerio");

// ============================================
// URLs
// ============================================
const LOGIN_URL = "https://samvidha.iare.ac.in/pages/login/checkUser.php";
const ACADEMIC_URL = "https://samvidha.iare.ac.in/home?action=stud_att_STD";
const BIOMETRIC_URL = "https://samvidha.iare.ac.in/home?action=std_bio";

// ============================================
// 1. LOGIN AND GET SESSION COOKIES
// ============================================
async function scrapeLogin(username, password) {
  const body = new URLSearchParams({
    username,
    password
  });

  const res = await axios.post(LOG_URL, body, {
    withCredentials: true,
    maxRedirects: 0,
    validateStatus: (s) => s < 500
  });

  const cookies = res.headers["set-cookie"];
  if (!cookies || cookies.length === 0) {
    throw new Error("Invalid Credentials");
  }

  return cookies;
}

// ============================================
// 2. FETCH ACADEMIC PAGE HTML
// ============================================
async function fetchAcademicHTML(cookies) {
  const res = await axios.get(ACADEMIC_URL, {
    headers: { Cookie: cookies.join("; ") }
  });
  return res.data;
}

// ============================================
// 3. FETCH BIOMETRIC PAGE HTML
// ============================================
async function fetchBiometricHTML(cookies) {
  const res = await axios.get(BIOMETRIC_URL, {
    headers: { Cookie: cookies.join("; ") }
  });
  return res.data;
}

// ============================================
// 4. PARSE ACADEMIC HTML (Final correct)
// ============================================
function parseAcademic(html) {
  const $ = cheerio.load(html);
  const rows = [];

  $("table tbody tr").each((i, row) => {
    const td = $(row).find("td");
    if (td.length < 9) return; // skip empty rows

    const conducted = Number(td.eq(5).text().trim());
    const attended = Number(td.eq(6).text().trim());
    const percentage = Number(td.eq(7).text().trim());

    // Calculate additional values (needed by your frontend)
    const classesToAttendFor75 =
      conducted >= attended
        ? Math.max(0, Math.ceil((0.75 * conducted - attended) / (1 - 0.75)))
        : 0;

    const classesCanBunk =
      percentage >= 75
        ? Math.floor(attended - 0.75 * conducted)
        : 0;

    rows.push({
      sno: td.eq(0).text().trim(),
      courseCode: td.eq(1).text().trim(),
      subject: td.eq(2).text().trim(),
      courseType: td.eq(3).text().trim(),
      courseCategory: td.eq(4).text().trim(),
      total: conducted,            // FRONTEND expects "total"
      attended: attended,
      percentage: percentage,
      status: td.eq(8).text().trim(),
      classesToAttendFor75,
      classesCanBunk
    });
  });

  return rows;
}

// ============================================
// 5. PARSE BIOMETRIC HTML (Final correct)
// ============================================
function parseBiometric(html) {
  const $ = cheerio.load(html);

  let totalDays = 0;
  let presentCount = 0;

  const logs = [];

  $("table tbody tr").each((i, row) => {
    const td = $(row).find("td");
    if (td.length < 10) return;

    const record = {
      sno: td.eq(0).text().trim(),
      roll: td.eq(1).text().trim(),
      name: td.eq(2).text().trim(),
      date: td.eq(3).text().trim(),
      iare_in: td.eq(4).text().trim(),
      iare_out: td.eq(5).text().trim(),
      iare_status: td.eq(6).text().trim(),
      jntuh_in: td.eq(7).text().trim(),
      jntuh_out: td.eq(8).text().trim(),
      jntuh_status: td.eq(9).text().trim()
    };

    logs.push(record);
    totalDays++;

    // determine present
    const present =
      record.iare_status.toLowerCase().includes("present") ||
      record.jntuh_status.toLowerCase().includes("present");

    if (present) presentCount++;
  });

  const percentage = totalDays === 0 ? 0 : ((presentCount / totalDays) * 100);

  return {
    totalDays,
    presentCount,
    percentage: Number(percentage.toFixed(2)),
    data: logs
  };
}

// ============================================
// 6. EXPORT for server.js
// ============================================
async function initBrowser() {
  return { browser: null, page: null };
}

async function login(page, username, password) {
  return await scrapeLogin(username, password);
}

async function fetchAcademic(cookies) {
  const html = await fetchAcademicHTML(cookies);
  return parseAcademic(html);
}

async function fetchBiometric(cookies) {
  const html = await fetchBiometricHTML(cookies);
  return parseBiometric(html);
}

module.exports = {
  initBrowser,
  login,
  fetchAcademic,
  fetchBiometric
};
