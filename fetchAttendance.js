// fetchAttendance.js — FINAL VERSION FOR REAL SAMVIDHA URLs (NO PUPPETEER)

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
    password,
  });

  const res = await axios.post(
    "https://samvidha.iare.ac.in/pages/login/checkUser.php",
    body,
    {
      withCredentials: true,
      maxRedirects: 0,
      validateStatus: (s) => s < 500,
    }
  );

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
    headers: {
      Cookie: cookies.join("; "),
    },
  });

  return res.data;
}

// ============================================
// 3. FETCH BIOMETRIC PAGE HTML
// ============================================
async function fetchBiometricHTML(cookies) {
  const res = await axios.get(BIOMETRIC_URL, {
    headers: {
      Cookie: cookies.join("; "),
    },
  });

  return res.data;
}

// ============================================
// 4. PARSE ACADEMIC HTML (Based on your HTML)
// ============================================
function parseAcademic(html) {
  const $ = cheerio.load(html);
  const rows = [];

  $("table tbody tr").each((i, row) => {
    const td = $(row).find("td");
    if (td.length < 9) return;

    rows.push({
      sno: td.eq(0).text().trim(),
      courseCode: td.eq(1).text().trim(),
      courseName: td.eq(2).text().trim(),
      courseType: td.eq(3).text().trim(),
      courseCategory: td.eq(4).text().trim(),
      conducted: Number(td.eq(5).text().trim()),
      attended: Number(td.eq(6).text().trim()),
      percentage: Number(td.eq(7).text().trim()),
      status: td.eq(8).text().trim(),
    });
  });

  return rows;
}

// ============================================
// 5. PARSE BIOMETRIC HTML (Based on your HTML)
// ============================================
function parseBiometric(html) {
  const $ = cheerio.load(html);
  const rows = [];

  $("table tbody tr").each((i, row) => {
    const td = $(row).find("td");
    if (td.length < 10) return;

    rows.push({
      sno: td.eq(0).text().trim(),
      roll: td.eq(1).text().trim(),
      name: td.eq(2).text().trim(),
      date: td.eq(3).text().trim(),

      iare_in: td.eq(4).text().trim(),
      iare_out: td.eq(5).text().trim(),
      iare_status: td.eq(6).text().trim(),

      jntuh_in: td.eq(7).text().trim(),
      jntuh_out: td.eq(8).text().trim(),
      jntuh_status: td.eq(9).text().trim(),

      classAttendance: td.eq(10)?.text()?.trim() || "",
    });
  });

  return rows;
}

// ============================================
// 6. EXPORT — match your server.js exactly
// ============================================

// server.js expects this to exist
async function initBrowser() {
  return { browser: null, page: null };
}

// server.js calls: login(page, username, password)
async function login(page, username, password) {
  return await scrapeLogin(username, password);
}

// server.js calls: fetchAcademic(page)
async function fetchAcademic(cookies) {
  const html = await fetchAcademicHTML(cookies);
  return parseAcademic(html);
}

// server.js calls: fetchBiometric(page)
async function fetchBiometric(cookies) {
  const html = await fetchBiometricHTML(cookies);
  return parseBiometric(html);
}

module.exports = {
  initBrowser,
  login,
  fetchAcademic,
  fetchBiometric,
};
