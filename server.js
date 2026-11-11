// Thin entry point kept for the LaunchAgent (`node server.js`).
// Composition lives in server/app.js (createApp), process lifecycle in
// server/index.js.
require('./server/index').start();
