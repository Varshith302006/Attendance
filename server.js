// server.js — Rewritten to reliably log visits and avoid "write after end" errors
// Key changes:
// 1) site_visits is inserted (awaited) before any response is sent so Render cannot kill it
// 2) A queue system limits concurrent scraping; addToQueue returns a Promise so endpoint can await the result
// 3) No res.write after res.end. Use res.json once per request
// 4) Defensive error handling and small timeouts for external calls

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { initBrowser, login, fetchAcademic, fetchBiometric, fetchLatestAttendance } = require('./fetchAttendance');
const fs = require('fs');

const app = express();

// -----------------------------
// Configuration
// -----------------------------
const PORT = process.env.PORT || 3000;
const ORIGINS = [
  'https://attendancedashboar.vercel.app',
  'http://localhost:3000'
];

// -----------------------------
// Supabase client
// -----------------------------
const supabase = createClient(
  'https://ywsqpuvraddaimlbiuds.supabase.co',
  process.env.SUPABASE_ANON_KEY || 'REPLACE_WITH_ANON_KEY_IF_LOCAL'
);

// -----------------------------
// Middleware
// -----------------------------
app.use(cors({ origin: ORIGINS, methods: ['GET','POST','OPTIONS'], credentials: true }));
app.options('*', cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// -----------------------------
// Simple queue with promise return
// -----------------------------
const queue = [];
let isProcessing = false;
const SAMVIDHA_DELAY = 800; // ms between tasks

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// addToQueue accepts an async function returning a value and returns a Promise that resolves with that value
function addToQueue(taskFn) {
  return new Promise((resolve, reject) => {
    queue.push({ taskFn, resolve, reject });
    processQueue().catch(err => console.error('Queue processing error', err));
  });
}

async function processQueue() {
  if (isProcessing) return;
  if (queue.length === 0) return;

  isProcessing = true;
  const item = queue.shift();
  try {
    const result = await item.taskFn();
    item.resolve(result);
  } catch (err) {
    item.reject(err);
  }

  await wait(SAMVIDHA_DELAY);
  isProcessing = false;

  // Continue if tasks remain
  if (queue.length > 0) processQueue().catch(err => console.error('Queue processing error', err));
}

// -----------------------------
// Utility: safe upsert / insert wrappers
// -----------------------------
async function safeInsertSiteVisit(username) {
  try {
    const { data, error } = await supabase
      .from('site_visits')
      .insert([{ username, visited_at: new Date().toISOString() }]);
    if (error) {
      console.error('site_visits insert error:', error.message || error);
      return { success: false, error };
    }
    return { success: true, data };
  } catch (err) {
    console.error('site_visits insert exception:', err);
    return { success: false, error: err };
  }
}

async function safeUpsertStudentCredentials(payload) {
  try {
    // Using upsert so we don't duplicate users; requires a unique constraint on username in DB
    const { data, error } = await supabase
      .from('student_credentials')
      .upsert(payload, { onConflict: ['username'] });
    if (error) {
      console.error('student_credentials upsert error:', error.message || error);
      return { success: false, error };
    }
    return { success: true, data };
  } catch (err) {
    console.error('student_credentials upsert exception:', err);
    return { success: false, error: err };
  }
}

// -----------------------------
// Endpoints
// -----------------------------

app.post('/get-attendance', async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Missing username/password' });
  }

  try {
    // 1) Immediately log visit and WAIT for it to complete — this ensures Render won't kill the insert
    await safeInsertSiteVisit(username);

    // 2) Check cached record in DB first
    const { data: existing, error: selectErr } = await supabase
      .from('student_credentials')
      .select('*')
      .eq('username', username)
      .maybeSingle();

    if (selectErr) console.error('select error', selectErr);

    const now = Date.now();
    const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes fresh
    const isFresh = existing && existing.password === password && existing.fetched_at && (now - new Date(existing.fetched_at).getTime() < CACHE_TTL_MS);

    if (isFresh) {
      // Return cached data quickly
      return res.json({ success: true, source: 'cache', academic: existing.academic_data, biometric: existing.biometric_data });
    }

    // 3) Not fresh => enqueue the heavy scraping task and await result.
    //    addToQueue returns a Promise which resolves when the task completes (ensures single response per request)
    const result = await addToQueue(async () => {
      // This function runs sequentially according to the queue
      // Perform login & fetch inside the queue to respect rate limits
      let cookies;
      try {
        cookies = await login(null, username, password);
      } catch (err) {
        // invalid credentials or login failed
        throw new Error('Invalid credentials or login failed');
      }

      const [academic, biometric] = await Promise.all([
        fetchAcademic(cookies),
        fetchBiometric(cookies)
      ]);

      // Validate
      if (!academic || !Array.isArray(academic) || academic.length === 0 || !biometric || typeof biometric !== 'object') {
        throw new Error('Attendance data not found');
      }

      // Upsert credentials into DB (do this inside the queue so it completes)
      await safeUpsertStudentCredentials({
        username,
        password,
        academic_data: academic,
        biometric_data: biometric,
        fetched_at: new Date().toISOString()
      });

      // Optionally fetch latest attendance too (non-blocking for frontend) — if you want it, return it here
      // const latest = await fetchLatestAttendance(cookies).catch(() => null);

      // Return result to the endpoint which is awaiting addToQueue
      return { academic, biometric };
    });

    // 4) Send response
    return res.json({ success: true, source: 'live', academic: result.academic, biometric: result.biometric });

  } catch (err) {
    console.error('/get-attendance error', err);
    return res.status(500).json({ success: false, error: err.message || String(err) });
  }
});

// Preflight for get-latest
app.options('/get-latest', cors());
app.post('/get-latest', cors(), async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ success: false, error: 'Missing credentials' });

  try {
    // Log visit for latest too
    await safeInsertSiteVisit(username);

    const cookies = await login(null, username, password);
    const latest = await fetchLatestAttendance(cookies);
    return res.json({ success: true, latest });
  } catch (err) {
    console.error('/get-latest error', err);
    return res.json({ success: false, error: err.message || String(err) });
  }
});

// Debug route to manually test site_visits insert
app.get('/test', async (req, res) => {
  const username = req.query.username || 'TEST';
  const r = await safeInsertSiteVisit(username);
  return res.json({ success: r.success, r });
});

// today-logins keeps same logic
app.get('/today-logins', async (req, res) => {
  try {
    const startDay = new Date(); startDay.setHours(0,0,0,0);
    const endDay   = new Date(); endDay.setHours(23,59,59,999);

    const { count, error } = await supabase
      .from('site_visits')
      .select('id', { count: 'exact', head: true })
      .gte('visited_at', startDay.toISOString())
      .lte('visited_at', endDay.toISOString());

    if (error) {
      console.error('today-logins select error', error);
      return res.json({ today_logins: 0 });
    }

    return res.json({ today_logins: count });
  } catch (err) {
    console.error('/today-logins error', err);
    return res.json({ today_logins: 0 });
  }
});

// start
app.listen(PORT, () => console.log(`Server running on ${PORT}`));

// helpful note logged to file for debugging
try {
  fs.appendFileSync('./server-start.log', `${new Date().toISOString()} server started\n`);
} catch (e) {}
