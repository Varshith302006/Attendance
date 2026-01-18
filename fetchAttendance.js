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
    if (td.length < 5) return;

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
function getTodayStringIST() {
  const now = new Date();

  const day = now.toLocaleString("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
  });

  const month = now.toLocaleString("en-GB", {
    timeZone: "Asia/Kolkata",
    month: "short",
  });

  const year = now.toLocaleString("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
  });

  return `${day} ${month}, ${year}`;  // EX: 24 Nov, 2025
}

function parseLatestAttendance(html) {
  const $ = cheerio.load(html);

  const periods = {
    1: null, 2: null, 3: null,
    4: null, 5: null, 6: null
  };

  const today = getTodayStringIST();

  // IMPORTANT: Clean all weird spaces and commas
  const normalize = (s) =>
    s
      .replace(/[\u00A0\u2007\u202F]/g, " ")  // all NBSP types
      .replace(/,/g, "")                     // remove comma
      .replace(/\s+/g, " ")                  // collapse spaces
      .trim()
      .toLowerCase();

  let currentSubject = "";
  let rowCounter = 0;

 $("tr").each((i, row) => {
  // SUBJECT HEADER
  const th = $(row).find("th.bg-pink, th[class*='bg-pink']");
  if (th.length) {
    const txt = th.text().trim();
    currentSubject = txt.split("-")[1]?.trim() || txt;
    return;
  }

  // DATA ROW
  const td = $(row).find("td");
  if (td.length < 5) return;

  const rawDate = td.eq(1).text().trim();
  const period = Number(td.eq(2).text().trim());
  const topic = td.eq(3).text().trim();
  const status = td.eq(4).text().trim();

  if (period < 1 || period > 6) return;

  // MATCH ONLY TODAY'S DATE
  if (normalize(rawDate) === normalize(today)) {
    periods[period] = {
      period,
      subject: currentSubject,
      topic,
      date: rawDate,
      status,
      dateNorm: normalize(rawDate),
    };
  }
});


  const output = [];
  for (let p = 1; p <= 6; p++) {
    if (!periods[p]) {
      output.push({
        period: p,
        subject: "NOT UPDATED",
        topic: "-",
        date: "-",
        status: "NOT UPDATED",
        dateNorm: normalize("-")
      });
    } else {
      output.push(periods[p]);
    }
  }

  return output;
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

function parseAttendanceRegister(html) {
  const $ = cheerio.load(html);

  const records = [];
  let currentSubject = "";

  const normalize = (s) =>
    s.replace(/[\u00A0\u2007\u202F]/g, " ")
     .replace(/,/g, "")
     .replace(/\s+/g, " ")
     .trim();

  $("tr").each((_, row) => {

    // SUBJECT HEADER
    const th = $(row).find("th.bg-pink, th[class*='bg-pink']");
    if (th.length) {
      const txt = th.text().trim();
      currentSubject = txt.split("-")[1]?.trim() || txt;
      return;
    }

    // DATA ROW
    const td = $(row).find("td");
    if (td.length < 5) return;

    const date = normalize(td.eq(1).text());
    const period = Number(td.eq(2).text());
    const status = td.eq(4).text().trim().toUpperCase();

    if (!date || period < 1 || period > 6) return;

    records.push({
      subject: currentSubject,
      date,
      period,
      status: status.includes("PRESENT") ? "P" : "A"
    });
  });

  return records;
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
  fetchLatestAttendance,
   parseAttendanceRegister
};
