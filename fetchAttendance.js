// fetchAttendance.js — FIXED VERSION (Real Samvidha Login Flow)

const axios = require("axios");
const cheerio = require("cheerio");

// URLs
const LOGIN_PAGE = "https://samvidha.iare.ac.in/login";
const LOGIN_POST = "https://samvidha.iare.ac.in/login";
const ACADEMIC_URL = "https://samvidha.iare.ac.in/home?action=stud_att_STD";
const BIOMETRIC_URL = "https://samvidha.iare.ac.in/home?action=std_bio";

/* ============================================================
   1. REAL LOGIN (2-step like browser)
   ============================================================ */
async function scrapeLogin(username, password) {
  // STEP 1 → Get login page (get PHPSESSID + initial cookies)
  const loginPage = await axios.get(LOGIN_PAGE, {
    withCredentials: true,
    validateStatus: () => true,
  });

  const initialCookies = loginPage.headers["set-cookie"] || [];

  // STEP 2 → Submit login form inside this same session
  const body = new URLSearchParams({
    username,
    password,
  });

  const loginRes = await axios.post(LOGIN_POST, body, {
    headers: {
      Cookie: initialCookies.join("; "),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    withCredentials: true,
    maxRedirects: 0,
    validateStatus: () => true,
  });

  const loginCookies = loginRes.headers["set-cookie"] || [];

  // Merge initial + login cookies
  const finalCookies = [...initialCookies, ...loginCookies];

  if (finalCookies.length === 0) {
    throw new Error("Login failed — no session cookies");
  }

  return finalCookies;
}

/* ============================================================
   2. GET HTML PAGES USING LOGIN COOKIES
   ============================================================ */
async function fetchAcademicHTML(cookies) {
  const res = await axios.get(ACADEMIC_URL, {
    headers: { Cookie: cookies.join("; ") },
    withCredentials: true,
  });
  return res.data;
}

async function fetchBiometricHTML(cookies) {
  const res = await axios.get(BIOMETRIC_URL, {
    headers: { Cookie: cookies.join("; ") },
    withCredentials: true,
  });
  return res.data;
}

/* ============================================================
   3. PARSE ACADEMIC TABLE
   ============================================================ */
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

/* ============================================================
   4. PARSE BIOMETRIC TABLE
   ============================================================ */
function parseBiometric(html) {
  const $ = cheerio.load(html);
  let totalDays = 0;
  let presentCount = 0;

  $("table tbody tr").each((i, row) => {
    const td = $(row).find("td");
    if (td.length < 10) return;

    totalDays++;

    const iareStatus = td.eq(6).text().trim().toLowerCase();
    const jntuhStatus = td.eq(9).text().trim().toLowerCase();

    const isPresent =
      iareStatus.includes("present") ||
      jntuhStatus.includes("present");

    if (isPresent) presentCount++;
  });

  const percentage =
    totalDays === 0 ? 0 : (presentCount / totalDays) * 100;

  return {
    totalDays,
    presentCount,
    percentage: Number(percentage.toFixed(2)),
  };
}

/* ============================================================
   5. EXPORT FOR server.js
   ============================================================ */
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
  fetchBiometric,
};
