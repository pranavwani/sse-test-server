First, a quick refresher on SSE basics (since this is for testing all features and edge cases):
- SSE is a one-way stream from server to client (client uses `EventSource` in JS).
- The server sends data in a specific format: `event: type\nid: 123\ndata: {"msg":"hello"}\nretry: 5000\n\n` (double newline ends an event).
- Clients auto-reconnect on drops, using `Last-Event-ID` header for resumption.
- Edge cases include: reconnections, errors (e.g., HTTP 500), timeouts, large payloads, custom events, retries.
- Your proxy needs to handle chunked responses, headers, and forwarding without breaking the stream.

We'll use Node.js with Express because it's simple for servers, handles streaming well, and is common. If you prefer Python (Flask) or another language, let me know—we can switch.

### Step 1: Set Up the Project
- Create a new folder for this, say `sse-test-server`.
- Open a terminal there and run:
  ```
  npm init -y
  ```
  This creates a `package.json` file with defaults.
- Install the packages we'll need:
  ```
  npm install express cors body-parser
  ```
  - `express`: For building the web server.
  - `cors`: To allow cross-origin requests (important for testing from different domains, like your client SDK).
  - `body-parser`: To parse JSON from POST requests (for echo features).

- Create a file called `server.js` in the folder. We'll add code to it gradually.

Now, open `server.js` in your editor.

### Step 2: Import Modules and Create the Basic App
Add this at the top:
```javascript
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const app = express();

app.use(cors()); // Enable CORS for all routes
app.use(bodyParser.json()); // For parsing POST bodies
```
- **Why?** We import the libraries. `app` is our Express server instance.
- `app.use(cors())`: Allows your client (or proxy) from another origin to connect without browser blocking.
- `app.use(bodyParser.json())`: Lets us read JSON data from incoming POST requests (useful later for echoing).

Test it: At the bottom, add:
```javascript
app.listen(3000, () => {
  console.log('SSE test server running on http://localhost:3000');
});
```
Run `node server.js` in terminal. Visit `http://localhost:3000` in browser—you should see "Cannot GET /" (normal, since no routes yet). Kill it with Ctrl+C.

### Step 3: Add a Helper Function for Sending SSE Events
SSE requires specific headers and formatted data. Let's make a reusable function to send events properly.

Add this after the imports:
```javascript
// Helper to send SSE-formatted data
function sendEvent(res, data, options = {}) {
  if (options.id) res.write(`id: ${options.id}\n`);
  if (options.event) res.write(`event: ${options.event}\n`);
  if (options.retry) res.write(`retry: ${options.retry}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  res.flushHeaders(); // Ensure data is sent immediately
}
```
- **Why?** SSE events are plain text with fields like `id:` (for reconnection), `event:` (custom type, e.g., "update"), `retry:` (ms for client retry), and `data:` (the payload, JSON-stringified here for flexibility).
- `res.write()` sends chunks without closing the connection.
- `res.flushHeaders()` forces immediate sending (good for low-latency testing).
- `options` lets us customize per event (e.g., add ID or retry only when needed).

This covers SSE spec requirements for event structure.

### Step 4: Create the Basic Test Endpoint (/sse/test)
This is the core: A streaming endpoint that sends periodic events. We'll make it configurable via query params (e.g., ?interval=5000).

Add this route:
```javascript
app.get('/sse/test', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const { interval = 2000 } = req.query; // Default to 2s
  let count = 0;

  // Send initial message
  sendEvent(res, { message: 'Connected to test SSE server' });

  // Send events periodically
  const streamInterval = setInterval(() => {
    const payload = { time: new Date().toISOString(), count: ++count, message: 'Test event' };
    sendEvent(res, payload);
  }, parseInt(interval));

  // Cleanup on client disconnect
  req.on('close', () => {
    clearInterval(streamInterval);
    res.end();
  });
});
```
- **Why the headers?** `text/event-stream` tells the client it's SSE. `no-cache` prevents buffering issues. `keep-alive` keeps the connection open.
- `req.query`: Grabs URL params like ?interval=1000 for customization.
- Initial event: Confirms connection.
- Interval: Simulates ongoing stream (e.g., real-time updates).
- Cleanup: Stops the interval when client disconnects (prevents server leaks).

Test it: Run the server, then in browser console:
```javascript
const es = new EventSource('http://localhost:3000/sse/test');
es.onmessage = (e) => console.log(e.data);
```
You should see JSON logs every 2s. Close the tab to disconnect—server should log nothing extra.

### Step 5: Add More Query Params for Customization
Expand the `/sse/test` route to handle more options. Replace the const line with:
```javascript
const { interval = 2000, eventType, retry, maxEvents = Infinity } = req.query;
let lastId = 0;

// Initial connection message with optional retry
sendEvent(res, { message: 'Connected to test SSE server' }, { retry, id: ++lastId });
```
In the interval's sendNextEvent (add a function inside for clarity):
```javascript
function sendNextEvent() {
  if (count >= maxEvents) {
    res.end();
    return;
  }
  let payload = { time: new Date().toISOString(), count: ++count, message: 'Test event' };
  sendEvent(res, payload, { event: eventType, id: ++lastId });
}
```
Call `sendNextEvent()` in the setInterval instead of the old send.

- **Why?** `eventType`: Tests custom events (client can listen with `es.addEventListener('update', ...)`.
- `retry`: Sets client reconnection delay.
- `maxEvents`: Limits stream length (e.g., ?maxEvents=5) for finite tests.
- `id`: Enables resumption—on reconnect, client sends `Last-Event-ID` header.

Add reconnection handling right after headers:
```javascript
if (req.headers['last-event-id']) {
  sendEvent(res, { message: `Reconnected after ID ${req.headers['last-event-id']}` }, { id: ++lastId });
}
```
Test: Connect, let a few events come, kill server, restart, reconnect—should see reconnect message.

### Step 6: Add Edge Cases (Delays, Large Payloads, Errors)
Still in `/sse/test`, add more query params:
```javascript
const { ..., delay, largePayload, errorAfter } = req.query; // Add to destructuring
```
In the interval:
```javascript
setInterval(() => {
  if (errorAfter && count == errorAfter) {
    res.status(500).end('Simulated server error');
    return;
  }
  if (delay) {
    setTimeout(sendNextEvent, parseInt(delay));
  } else {
    sendNextEvent();
  }
}, parseInt(interval));
```
In payload:
```javascript
if (largePayload) {
  payload.largeData = 'x'.repeat(1024 * 1024); // ~1MB
}
```
- **Why?** `delay`: Tests slow streams (e.g., ?delay=5000).
- `largePayload`: Checks proxy buffering/memory (big data chunks).
- `errorAfter`: Simulates failures mid-stream (client should retry).

Test: Try `/sse/test?errorAfter=3`—gets 3 events, then 500 error.

### Step 7: Add Echo Endpoint (/sse/echo)
For testing proxy forwarding of data (e.g., if your middleware sends POSTs).

Add:
```javascript
app.post('/sse/echo', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const data = req.body;
  sendEvent(res, { echoed: data }, { event: 'echo' });
  res.end(); // End after one event
});
```
- **Why?** POST JSON (e.g., via curl: `curl -X POST -H "Content-Type: application/json" -d '{"test": "hello"}' http://localhost:3000/sse/echo`), get it echoed as SSE. Tests if your proxy handles body forwarding and streams the response.

### Step 8: Add Error and Timeout Endpoints
For failure testing.

Add:
```javascript
app.get('/sse/error', (req, res) => {
  const { code = 500 } = req.query;
  res.status(parseInt(code)).send('Simulated SSE error');
});

app.get('/sse/timeout', (req, res) => {
  setTimeout(() => {
    res.status(408).send('Simulated timeout');
  }, 30000); // 30s delay
});
```
- **Why?** `/sse/error?code=404`: Tests HTTP errors (client onerror).
- `/sse/timeout`: Hangs to simulate slow/no response (tests proxy timeouts).

### Step 9: Add Multi-Event Type Endpoint (/sse/multi)
For testing different event types.

Add:
```javascript
app.get('/sse/multi', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  let id = 0;
  ['ping', 'update', 'alert'].forEach((type, index) => {
    setTimeout(() => {
      sendEvent(res, { message: `Event of type ${type}` }, { event: type, id: ++id });
      if (index === 2) res.end();
    }, index * 1000);
  });

  req.on('close', () => res.end());
});
```
- **Why?** Sends sequenced events with different types—tests client filtering.

### Step 10: Add Logging and Final Touches
In the listen callback, add:
```javascript
console.log('Endpoints:');
console.log('- /sse/test?interval=1000&eventType=custom&retry=5000&maxEvents=10&delay=2000&largePayload=true&errorAfter=5');
console.log('- POST /sse/echo (send JSON body)');
console.log('- /sse/error?code=404');
console.log('- /sse/timeout');
console.log('- /sse/multi');
```
This reminds you of options when starting.

For debugging, add `console.log('Client connected/disconnected')` in routes and close handlers.

### Final Testing and Usage
- Run `node server.js`.
- Use your proxy: Point it at e.g., `http://localhost:3000/sse/test?maxEvents=10`.
- Test edges: Reconnects (kill/restart server), errors, large data.
- Understand: This covers SSE spec—streams, IDs, retries, errors. Your proxy should transparently forward without closing connections early.
