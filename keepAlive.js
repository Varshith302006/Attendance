const http = require('http');
const https = require('https');

// Use an environment variable name instead of a literal URL
const URL = process.env.APP_URL; // Set APP_URL in Render environment variables
const INTERVAL = 5 * 60 * 1000; // every 5 minutes

if (!URL) {
  console.error("APP_URL environment variable not set!");
  process.exit(1);
}

function ping() {
  const client = URL.startsWith('https') ? https : http;

  client.get(URL, (res) => {
    console.log(`Keep-alive ping sent. Status: ${res.statusCode}`);
  }).on('error', (err) => {
    console.error(`Error pinging URL: ${err.message}`);
  });
}

setInterval(ping, INTERVAL);
console.log(`Keep-alive ping started for ${URL}`);
