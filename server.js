// server.js — Queue-safe NDJSON streamer (Option B)
// - addToQueue returns a Promise (so endpoint can await result)
// - queue processes tasks one at a time with a small delay
// - endpoint holds res open, awaits queued task result, then writes NDJSON lines and ends
// - all Supabase calls use await inside try/catch (no .catch() on non-Promises)

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

// Your scraping helpers (should return Promises)
const {
  initBrowser,
  login,
  fetchAcademic,
  fetchBiometric,
  fetchLatestAttendance
} = require('./fetchAttendance');

const app = express();

// -----------------------------
// Config
// -----------------------------
const PORT = process.env.PORT || 3000;
const ORIGINS = [
  'https://attendancedashboar.vercel.app',
  'http://localhost:3000',
  // add your deployed domain if needed
];

// -----------------------------
// Supabase client (use env vars in production)
// -----------------------------
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ywsqpuvraddaimlbiuds.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl3c3FwdXZyYWRkYWltbGJpdWRzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjA4MjMzMDgsImV4cCI6MjA3NjM5OTMwOH0.UqkzzWM7nRvgtNdvRy63LLN-UGv-zeYYx6tRYD5zxdY';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// -----------------------------
// Middleware
// -----------------------------
app.use(cors({
  origin: ORIGINS,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.options('*', cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// -----------------------------
// Logging helpers
// -----------------------------
const LOG_FILE = './server-start.log';
function appendLog(line) {
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}

// -----------------------------
// Queue (single-instance processing)
// -----------------------------
const queue = [];
let isProcessing = false;
const SAMVIDHA_DELAY = Number(process.env.SAMVIDHA_DELAY_MS || 800); // ms between tasks

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// addToQueue accepts a taskFn that returns a Promise/result and returns a Promise that resolves with that result
function addToQueue(taskFn) {
  return new Promise((resolve, reject) => {
    queue.push({ taskFn, resolve, reject });
    // start processing if not running
    processQueue().catch(err => {
      console.error('processQueue error', err);
    });
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

  // polite delay between tasks
  await wait(SAMVIDHA_DELAY);

  isProcessing = false;

  // continue if more tasks queued
  if (queue.length > 0) processQueue().catch(err => {
    console.error('processQueue continuation error', err);
  });
}

// -----------------------------
// Utility: timeout wrapper
// -----------------------------
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || `Timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

// -----------------------------
// Safe DB wrappers (await + try/catch)
// -----------------------------
async function insertSiteVisit(username) {
  try {
    const { data, error } = await supabase
      .from('site_visits')
      .insert([{ username, visited_at: new Date().toISOString() }]);
    if (error) {
      console.error('site_visits insert error', error);
      return { success: false, error };
    }
    return { success: true, data };
  } catch (err) {
    console.error('site_visits insert exception', err);
    return { success: false, error: err };
  }
}

async function upsertStudentCredentials(payload) {
  try {
    const { data, error } = await supabase
      .from('student_credentials')
      .upsert(payload, { onConflict: ['username'] });
    if (error) {
      console.error('student_credentials upsert error', error);
      return { success: false, error };
    }
    return { success: true, data };
  } catch (err) {
    console.error('student_credentials upsert exception', err);
    return { success: false, error: err };
  }
}

// -----------------------------
// Routes
// -----------------------------

// 1) Run selected (cron-like)
app.post('/run-selected', async (req, res) => {
  const { usernames } = req.body;
  if (!Array.isArray(usernames) || usernames.length === 0) {
    return res.status(400).json({ success: false, message: 'Usernames must be a non-empty array' });
  }

  const start = Date.now();
  let processed = 0, succeeded = 0, skipped = 0;

  try {
    const { data: users, error } = await supabase
      .from('student_credentials')
      .select('Id, username, password')
      .in('username', usernames);

    if (error) throw error;
    if (!users || users.length === 0) {
      return res.json({ success: true, message: 'No matching users', processed: 0 });
    }

    for (const user of users) {
      processed++;
      if (!user.username || !user.password) {
        skipped++;
        continue;
      }

      try {
        const cookies = await withTimeout(login(null, user.username, user.password), 25_000, 'Login timed out');
        const [academic, biometric] = await Promise.all([
          withTimeout(fetchAcademic(cookies), 30_000, 'fetchAcademic timed out'),
          withTimeout(fetchBiometric(cookies), 30_000, 'fetchBiometric timed out')
        ]);

        await supabase
          .from('student_credentials')
          .update({
            academic_data: academic,
            biometric_data: biometric,
            fetched_at: new Date().toISOString()
          })
          .eq('Id', user.Id);

        succeeded++;
      } catch (err) {
        console.error(`user ${user.username} failed:`, err && err.message ? err.message : err);
        skipped++;
      }
    }

    const elapsed = Math.round((Date.now() - start) / 1000);
    return res.json({ success: true, processed, succeeded, skipped, time_seconds: elapsed });

  } catch (err) {
    console.error('run-selected error', err);
    return res.status(500).json({ success: false, message: String(err) });
  }
});

// 2) Run cron (fetch all)
app.get('/run-cron', async (req, res) => {
  const start = Date.now();
  try {
    const { data: users, error } = await supabase
      .from('student_credentials')
      .select('Id, username, password');

    if (error) throw error;

    let processed = 0, succeeded = 0, skipped = 0;

    for (const user of users || []) {
      processed++;
      if (!user.username || !user.password) {
        skipped++;
        continue;
      }

      try {
        const cookies = await withTimeout(login(null, user.username, user.password), 25_000, 'Login timed out');
        const [academic, biometric] = await Promise.all([
          withTimeout(fetchAcademic(cookies), 30_000, 'fetchAcademic timed out'),
          withTimeout(fetchBiometric(cookies), 30_000, 'fetchBiometric timed out')
        ]);

        await supabase
          .from('student_credentials')
          .update({
            academic_data: academic,
            biometric_data: biometric,
            fetched_at: new Date().toISOString()
          })
          .eq('Id', user.Id);

        succeeded++;
      } catch (err) {
        console.error(`cron user ${user?.username} failed:`, err && err.message ? err.message : err);
        skipped++;
      }
    }

    const elapsed = Math.round((Date.now() - start) / 1000);
    return res.json({ success: true, processed, succeeded, skipped, time_seconds: elapsed });
  } catch (err) {
    console.error('run-cron error', err);
    return res.status(500).json({ success: false, message: String(err) });
  }
});

// 3) get-attendance (main live route used by frontend)
// Behavior:
//  - validate input
//  - log visit (non-blocking but awaited best-effort)
//  - enqueue a taskFn that returns the scraped result
//  - await addToQueue(taskFn) so res stays open while job runs
//  - after job completes, write NDJSON lines and end response
app.post('/get-attendance', async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    // immediate error line
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.write(JSON.stringify({ step: 'error', data: 'Missing username/password' }) + '\n');
    return res.end();
  }

  // Setup NDJSON headers
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  // Transfer-Encoding: chunked is implied; explicit header is rarely required
  if (res.flushHeaders) try { res.flushHeaders(); } catch (e) {}

  // Best-effort log (non-blocking)
  (async () => {
    try {
      await insertSiteVisit(username);
    } catch (e) {
      // ignore
    }
  })();

  // Build the queued task function (do not access `res` inside this function)
  const taskFn = async () => {
    // This runs in queue sequentially
    // Return an object with fields: academic, biometric, latest, fetched_at
    // Throw errors for auth/fetch failures
    // 1) Login
    let cookies;
    try {
      cookies = await withTimeout(login(null, username, password), 25_000, 'Login timed out');
    } catch (err) {
      const e = new Error('Invalid credentials or login failed');
      e.code = 'AUTH_FAILED';
      throw e;
    }

    // 2) Fetch academic & biometric in parallel (with timeouts)
    let academic, biometric, latest = null;
    try {
      [academic, biometric] = await Promise.all([
        withTimeout(fetchAcademic(cookies), 30_000, 'fetchAcademic timed out'),
        withTimeout(fetchBiometric(cookies), 30_000, 'fetchBiometric timed out')
      ]);
    } catch (err) {
      const e = new Error('Failed to fetch attendance data');
      e.code = 'FETCH_FAILED';
      throw e;
    }

    if (!academic || !Array.isArray(academic) || academic.length === 0) {
      const e = new Error('Academic attendance empty');
      e.code = 'NO_ACADEMIC';
      throw e;
    }

    // Optionally fetch latest attendance (best-effort)
    try {
      latest = await withTimeout(fetchLatestAttendance(cookies), 15_000, 'fetchLatestAttendance timed out');
    } catch (err) {
      latest = null;
    }

    // Upsert credentials & fetched_at (best-effort; swallow DB failure)
    (async () => {
      try {
        await upsertStudentCredentials({
          username,
          password,
          academic_data: academic,
          biometric_data: biometric,
          fetched_at: new Date().toISOString()
        });
      } catch (e) {
        console.error('upsertStudentCredentials failed (non-fatal)', e && e.message ? e.message : e);
      }
    })();

    return {
      academic,
      biometric,
      latest,
      fetched_at: new Date().toISOString()
    };
  };

  try {
    // Enqueue and await the result — this keeps the HTTP connection open for the client
    const result = await addToQueue(taskFn);

    // At this point `result` is available — write NDJSON lines and end the response
    try {
      // academic
      res.write(JSON.stringify({ step: 'academic', data: result.academic }) + '\n');

      // biometric (could be null)
      res.write(JSON.stringify({ step: 'biometric', data: result.biometric || null }) + '\n');

      // latest (may be null)
      res.write(JSON.stringify({ step: 'latest', data: result.latest || null }) + '\n');

      // fetched_at
      res.write(JSON.stringify({ step: 'fetched_at', data: result.fetched_at }) + '\n');

      // done marker
      res.write(JSON.stringify({ step: 'done', success: true }) + '\n');

      return res.end();
    } catch (writeErr) {
      console.error('Error writing response', writeErr);
      // If write failed, try to end
      try { res.end(); } catch (_) {}
      return;
    }
  } catch (err) {
    // If taskFn throws (e.g., auth failed), stream an error line
    try {
      const msg = err && err.message ? err.message : 'Unknown error';
      res.write(JSON.stringify({ step: 'error', data: msg }) + '\n');
      res.write(JSON.stringify({ step: 'done', success: false }) + '\n');
      return res.end();
    } catch (streamErr) {
      console.error('Failed to stream error to client', streamErr);
      try { res.end(); } catch (_) {}
      return;
    }
  }
});

// get-latest (non-streaming)
app.options('/get-latest', cors());
app.post('/get-latest', cors(), async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ success: false, error: 'Missing credentials' });

  try {
    const cookies = await withTimeout(login(null, username, password), 25_000, 'Login timed out');
    const latest = await withTimeout(fetchLatestAttendance(cookies), 15_000, 'fetchLatestAttendance timed out');
    return res.json({ success: true, latest });
  } catch (err) {
    console.error('/get-latest error', err);
    return res.json({ success: false, error: err.message || String(err) });
  }
});

// today-logins (count)
app.get('/today-logins', async (req, res) => {
  try {
    const startDay = new Date(); startDay.setHours(0,0,0,0);
    const endDay = new Date(); endDay.setHours(23,59,59,999);

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

// health
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// start
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
  appendLog(`${new Date().toISOString()} server started on ${PORT}`);
});
