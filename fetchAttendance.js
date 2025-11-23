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
  const checkBody = new URLSearchParams({
    username,
    password
  });

  const checkRes = await axios.post(
    "https://samvidha.iare.ac.in/pages/login/checkUser.php",
    checkBody,
    {
      withCredentials: true,
      validateStatus: () => true
    }
  );

  if (!checkRes.data || checkRes.data.success === false) {
    throw new Error("Invalid Credentials");
  }

  let cookies = checkRes.headers["set-cookie"] || [];

  const dashboard = await axios.get(
    "https://samvidha.iare.ac.in/home",
    {
      headers: { Cookie: cookies.join("; ") },
      withCredentials: true,
      validateStatus: () => true
    }
  );

  const newCookies = dashboard.headers["set-cookie"] || [];
  cookies = [...cookies, ...newCookies];

  return cookies;
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

    const conducted = Number(td.eq(5).text().trim());
    const attended = Number(td.eq(6).text().trim());
    const percentage = Number(td.eq(7).text().trim());

    // Calculate required fields
    const target = 75;

    // Classes required to reach 75%
    let classesToAttend = 0;
    if (percentage < target) {
      classesToAttend = Math.ceil((0.75 * conducted - attended) / (1 - 0.75));
    }

    // Classes can bunk
    let classesCanBunk = 0;
    if (percentage > target) {
      classesCanBunk = Math.floor((attended - 0.75 * conducted) / 0.75);
    }

    rows.push({
      sno: td.eq(0).text().trim(),
      courseCode: td.eq(1).text().trim(),
      subject: td.eq(2).text().trim(),
      courseType: td.eq(3).text().trim(),
      courseCategory: td.eq(4).text().trim(),
      total: conducted,
      attended: attended,
      percentage: percentage,
      status: td.eq(8).text().trim(),
      classesToAttendFor75: classesToAttend,
      classesCanBunk: classesCanBunk
    });
  });

  return rows;
}

/* ============================================================
   4. PARSE BIOMETRIC TABLE
   ============================================================ */
function parseBiometric(html) {
  const $ = cheerio.load(html);
  let totalDays = -1;
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
   PARSE LATEST ATTENDANCE (subject only from its own <th>)
   ============================================================ */
function parseLatestAttendance(html) {
  const $ = cheerio.load(html);

  // Find the pink header for THIS subject’s table
  const header = $("th.bg-pink").first().text().trim();

  // Example: "ACSD08 - Data Structures"
  // Extract only subject name (right side of "-")
  const subject = header.includes("-")
    ? header.split("-")[1].trim()
    : header;

  // Find first (latest) row in table
  let latest = null;

  $("table tbody tr").each((i, row) => {
    const td = $(row).find("td");
    if (td.length < 5) return;

    if (!latest) {
      latest = {
        subject,
        date: td.eq(0).text().trim(),
        period: td.eq(1).text().trim(),
        status: td.eq(4).text().trim(),
      };
    }
  });

  return latest;
}
async function fetchLatestAttendanceHTML(cookies) {
  const res = await axios.get(
    "https://samvidha.iare.ac.in/home?action=course_content",
    {
      headers: { Cookie: cookies.join("; ") },
      withCredentials: true,
    }
  );
  return res.data;
}

async function fetchLatestAttendance(cookies) {
  const html = await fetchLatestAttendanceHTML(cookies);
  return parseLatestAttendance(html);
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
  fetchBiometric,,
  fetchLatestAttendance
};
