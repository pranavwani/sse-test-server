import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { createServer } from 'https';
import { readFileSync } from 'fs';
import swaggerUi from 'swagger-ui-express';
import { fileURLToPath } from 'url';
import path from 'path';
import YAML from 'yaml';
import fs from 'fs';

const app = express();

const PORT = process.env.PORT || 3000;
const USE_HTTPS = process.env.USE_HTTPS === 'true';

const storeExpirations = new Map(); // streamId -> timeout ID
const DEFAULT_TLS_MS = 3000000; // 5 min

app.use(cors()); // Enable CORS for all routes
app.use(bodyParser.json()); // For parsing POST bodies

// ---- Swagger UI & Spec ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load YAML once at boot
const specPath = path.resolve(__dirname, '.', 'openapi.yml');
const swaggerDocument = YAML.parse(fs.readFileSync(specPath, 'utf8'));

// Serve Swagger UI at ROOT /
app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(swaggerDocument, {
        // Optional nice tweaks:
        explorer: true, // Shows search bar
        customSiteTitle: 'SSE Test Server',
        swaggerOptions: {
            displayRequestDuration: true,
            // docExpansion: 'none',            // Collapse sections by default
            // defaultModelsExpandDepth: -1,    // Hide models if you want cleaner look
        },
        customCss: '.swagger-ui .topbar { display: none }', // Optional: hide top bar for cleaner root page
    }),
);

const eventStore = new Map(); // Key: streamId, Value: array of {id, data}

// Helper to send SSE-formatted data
function sendEvent(res, data, options = {}) {
    if (options.id) res.write(`id: ${options.id}\n`);
    if (options.event) res.write(`event: ${options.event}\n`);
    if (options.retry) res.write(`retry: ${options.retry}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    res.flushHeaders(); // Ensure data is sent immediately
}

function setStoreExpiration(streamId) {
    // Clear any existing timer for this streamId
    if (storeExpirations.has(streamId)) {
        clearTimeout(storeExpirations.get(streamId));
    }
    const timeout = setTimeout(() => {
        eventStore.delete(streamId);
        storeExpirations.delete(streamId);
        console.log(`Auto-expired inactive stream: ${streamId}`);
    }, DEFAULT_TLS_MS);

    storeExpirations.set(streamId, timeout);
}

// Global state for all streams
const streams = new Map();
// streamId → {
//   events: array of {id, data, event: string?},  // Stored history for catch-up
//   timer: NodeJS.Timeout | null,                 // Global interval for generating events
//   lastActivity: number (Date.now()),            // For inactivity timeout
//   eventCount: number,                           // Total events generated so far
//   lastId: number,                               // Last event ID
//   maxEvents: number | Infinity,                 // Locked per-stream limit
//   intervalMs: number,                           // Locked generation interval
//   Add other locked params if needed (e.g., eventType)
// };

// Constants for cleanup
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes of no connections → cleanup
const CLEANUP_INTERVAL_MS = 60 * 1000; // Check every 1 minute

// Global cleanup loop (runs forever in background)
setInterval(() => {
    const now = Date.now();
    for (const [streamId, state] of streams.entries()) {
        if (now - state.lastActivity > INACTIVITY_TIMEOUT_MS) {
            if (state.timer) {
                clearInterval(state.timer); // Stop generating events
                state.timer = null;
            }
            streams.delete(streamId); // Wipe the store
            console.log(`[Cleanup] Expired inactive stream: ${streamId}`);
        }
    }
}, CLEANUP_INTERVAL_MS);

// Basic test stream: Sends periodic events with optional configs via query params
app.get('/sse/test', (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });

    // Parse all query params (with defaults)
    const {
        interval = '2000', // ms between events
        eventType, // Custom event name (e.g., 'update')
        retry, // Client retry ms
        maxEvents = Infinity, // Max total events for this stream
        largePayload, // Boolean: Add ~1MB data
        errorAfter, // Send 500 after N events
        streamId = 'default', // Unique stream identifier
    } = req.query;

    // Convert strings to numbers safely
    const intervalMs = parseInt(interval) || 2000;
    
    const requestedMax = !isNaN(maxEvents) ? Number(maxEvents) : Infinity;
    
    const errorAfterNum = parseInt(errorAfter) || 0; // 0 = no error

    // Get or initialize shared state for this streamId
    let state;
    if (!streams.has(streamId)) {
        state = {
            events: [], // History for catch-up
            timer: null, // Will start below
            lastActivity: Date.now(),
            eventCount: 0,
            lastId: 0,
            maxEvents: requestedMax, // Lock on first connection
            intervalMs: intervalMs, // Lock interval too
        };
        streams.set(streamId, state);
        console.log(
            `[New] Created stream: ${streamId} (maxEvents=${state.maxEvents})`,
        );
    } else {
        state = streams.get(streamId);
        // Warn if trying to change locked params
        if (requestedMax !== Infinity && requestedMax !== state.maxEvents) {
            console.warn(
                `[Mismatch] For stream ${streamId}: maxEvents was ${state.maxEvents}, requested ${requestedMax} – using original`,
            );
        }
    }

    // Update activity timestamp (resets 5-min timeout)
    state.lastActivity = Date.now();

    // Start global event generator if not running and not finished
    if (!state.timer && state.eventCount < state.maxEvents) {
        state.timer = setInterval(() => {
            // Check limits before generating
            if (state.eventCount >= state.maxEvents) {
                clearInterval(state.timer);
                state.timer = null;
                console.log(
                    `[Finished] Stream ${streamId} reached maxEvents=${state.maxEvents}`,
                );
                  
                res.end();  // end the request
                
                streams.delete(streamId); // wipe the store
                
                storeExpirations.delete(streamId);  // clear store expiration

                return;
            }

            generateEvent();
            
            function generateEvent() {
                state.eventCount++;
                state.lastId++;

                let payload = {
                    time: new Date().toISOString(),
                    eventCount: state.eventCount,
                    message: 'Test event',
                };

                // Add large payload if requested
                if (largePayload === 'true') {
                    payload.largeData = 'x'.repeat(1024 * 1024); // ~1MB
                }

                // Simulate error if reached errorAfter
                if (errorAfterNum > 0 && state.eventCount === errorAfterNum) {
                    // Note: This ends the stream globally – adjust if per-connection needed
                    clearInterval(state.timer);
                    state.timer = null;
                    console.log(
                        `[Error] Stream ${streamId} simulated error after ${state.eventCount} events`,
                    );
                    // We can't send 500 here (since SSE is open) – instead, send error event
                    const errorEvent = {
                        id: state.lastId,
                        data: { error: 'Simulated server error' },
                        event: 'error',
                    };
                    state.events.push(errorEvent);
                    return;
                }

                const event = {
                    id: state.lastId,
                    data: payload,
                    event: eventType,
                };
                state.events.push(event);

                // Limit history size to prevent memory growth
                if (state.events.length > 2000) state.events.shift(); // Keep last 2000
            }
        }, state.intervalMs);
    }

    // Handle reconnection / catch-up
    const lastEventId = req.headers['last-event-id']
        ? parseInt(req.headers['last-event-id'])
        : 0;
    let lastSentId = lastEventId;

    if (lastEventId > 0) {
        const startIndex =
            state.events.findIndex((e) => e.id === lastEventId) + 1;
        if (startIndex > 0) {
            // Send missed events
            for (let i = startIndex; i < state.events.length; i++) {
                const e = state.events[i];
                sendEvent(res, e.data, { id: e.id, event: e.event, retry });
                lastSentId = e.id;
            }
            sendEvent(
                res,
                { message: `Resumed from ID ${lastEventId}` },
                { id: lastSentId + 1, retry },
            );
            lastSentId++;
        } else {
            lastSentId = -1;
            sendEvent(
                res,
                { message: 'Last-Event-ID not found – starting live' },
                { retry },
            );
        }
    } else {
        sendEvent(res, { message: 'Connected to live stream' }, { retry });
    }

    // Live tail: Poll for new events and send them
    const liveInterval = setInterval(() => {
        if (lastSentId < state.lastId) {
            const newEvents = state.events.filter((e) => e.id > lastSentId);
            newEvents.forEach((e) => {
                sendEvent(res, e.data, { id: e.id, event: e.event, retry });
                lastSentId = e.id;
            });
        }
    }, 500); // Poll every 500ms – efficient for low latency

    // On client disconnect
    req.on('close', () => {
        clearInterval(liveInterval); // Stop this client's poller
        res.end();
        // Do NOT stop global timer or wipe store – inactivity cleanup handles that
        // But update activity one last time (optional, for grace period)
        if (streams.has(streamId)) {
            streams.get(streamId).lastActivity = Date.now();
        }
    });
});

// Add this route anywhere in your app (preferably after the GET routes)
app.delete('/sse/stream/:streamId', (req, res) => {
    const { streamId } = req.params;

    if (!streams.has(streamId)) {
        return res.status(404).json({ error: `Stream ${streamId} not found` });
    }

    const state = streams.get(streamId);

    // Stop generation
    if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
    }

    // Wipe the store
    streams.delete(streamId);

    console.log(`[Manual Cleanup] Deleted stream: ${streamId}`);

    res.status(200).json({
        message: `Stream ${streamId} stopped and deleted successfully`,
        wasActive: !!state.timer,
        eventCount: state.eventCount,
        lastId: state.lastId,
    });
});

// Echo endpoint: POST data to /sse/echo, and it streams it back as SSE events
app.post('/sse/echo', (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });

    const data = req.body;
    sendEvent(res, { echoed: data }, { event: 'echo' });
    res.end(); // Single event for simplicity, or extend to stream
});

// Error simulation endpoint
app.get('/sse/error', (req, res) => {
    const { code = 500 } = req.query;
    res.status(parseInt(code)).send('Simulated SSE error');
});

// Timeout simulation: Hangs for a long time
app.get('/sse/timeout', (req, res) => {
    // Parse delay from query param (in milliseconds)
    // Default to 30 seconds if missing or invalid
    let delayMs = Math.max(1000, parseInt(req.query.delay) || 30000); // min 1s to avoid abuse

    // Optional: also support ?seconds= for readability
    if (req.query.seconds) {
        const seconds = parseInt(req.query.seconds);
        if (!isNaN(seconds) && seconds > 0) {
            delayMs = seconds * 1000;
        }
    }

    // Optional logging for debugging
    console.log(
        `[Timeout] Simulating delay of ${delayMs}ms for request from ${req.ip}`,
    );

    // Send headers immediately (important for SSE-like feel, even though we eventually 408)
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });

    // Send an initial message so client knows connection is open
    res.write('data: Waiting for simulated timeout...\n\n');
    res.flushHeaders();

    // Delay and then respond with 408 (Request Timeout)
    setTimeout(() => {
        res.write(`data: Simulated timeout reached after ${delayMs/1000} seconds\n\n`);
        res.write(`event: timeout\ndata: Connection will now close\n\n`);
        
        res.end();
    }, delayMs);
});

// Multi-event type stream for testing custom events
app.get('/sse/multi', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // Parse query params with safe defaults
  const intervalMs = Math.max(100, parseInt(req.query.interval) || 1000);     // min 100ms to avoid spam
  const eventCount = Math.max(1, Math.min(100, parseInt(req.query.count) || 3)); // 1–100 limit
  const customTypes = req.query.types 
    ? req.query.types.split(',').map(t => t.trim()).filter(t => t) 
    : ['ping', 'update', 'alert']; // default cycle
  const delayFirstMs = parseInt(req.query.delayFirst) || 0;

  let index = 0;
  let sentCount = 0;

  // Optional: initial delay
  setTimeout(() => {
    const sendNext = () => {
      if (sentCount >= eventCount) {
        res.write('data: Sequence complete\n\n');
        res.end();
        return;
      }

      // Cycle through types
      const eventType = customTypes[index % customTypes.length];
      
      index++;

      const payload = {
        message: `Event of type ${eventType} (${sentCount + 1}/${eventCount})`,
        sequenceIndex: sentCount + 1,
        timestamp: new Date().toISOString()
      };

      sendEvent(res, payload, { 
        event: eventType,
        id: sentCount + 1  // simple incremental ID
      });

      sentCount++;

      // Schedule next
      setTimeout(sendNext, intervalMs);
    };

    // Start the sequence
    sendNext();
  }, delayFirstMs);

  // Cleanup on client disconnect
  req.on('close', () => {
    res.end();
  });
});

// File streaming simulation
app.get('/sse/stream-file', (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });

    const {
        totalBytes = 1024 * 1024, // default 1 MB
        chunkSize = 8192, // ~8KB per chunk (realistic)
        delayMs = 50, // ms between chunks
        streamId = 'sim-file-' + Date.now(), // unique by default
        eventType = 'chunk',
        format = 'text', // 'text' | 'jsonl' | 'binary'
    } = req.query;

    const totalBytesNum = parseInt(totalBytes);
    const chunkSizeNum = Math.max(1, parseInt(chunkSize));
    const delayNum = parseInt(delayMs);

    // For resumption support
    if (!eventStore.has(streamId)) {
        eventStore.set(streamId, []);
    }

    const stored = eventStore.get(streamId);

    let byteSent = 0;
    let chunkIndex = 0;
    let lastId = 0;

    // Handle reconnection with Last-Event-ID
    const lastEventId = req.headers['last-event-id']
        ? parseInt(req.headers['last-event-id'])
        : 0;

    if (lastEventId > 0) {
        const resumeIndex = stored.findIndex((e) => e.id === lastEventId);

        if (resumeIndex > 0) {
            for (let i = resumeIndex; i < stored.length; i++) {
                sendEvent(res, stored[i].data, {
                    id: stored[i].id,
                    event: eventType,
                });
            }
            byteSent = stored.length * chunkSizeNum; // approximate
            chunkIndex = stored.length;
            lastId = lastEventId;
            sendEvent(
                res,
                {
                    message: `Resume simulated file chunk from chunk ${chunkIndex}`,
                },
                { id: ++lastId },
            );
        }
    } else {
        sendEvent(
            res,
            {
                message: `Starting simulated file stream`,
            },
            { id: ++lastId },
        );
    }

    setStoreExpiration(streamId);

    const interval = setInterval(() => {
        if (byteSent >= totalBytesNum) {
            sendEvent(res, {}, { id: ++lastId, event: 'end' });
            clearInterval(interval);
            res.end();
            return;
        }

        chunkIndex++;
        lastId++;

        let chunkData;
        if (format === 'jsonl') {
            chunkData =
                JSON.stringify({
                    chunk: chunkIndex,
                    timeStamp: new Date().toISOString(),
                    data: 'x'.repeat(chunkSizeNum - 50), // approximate size
                }) + '\n';
        } else if (format === 'binary') {
            // For binary testing (Base64 encoded in data field)
            const buffer = Buffer.alloc(chunkSizeNum).fill('x');
            chunkData = buffer.toString('base64');
        } else {
            // plain text
            chunkData = 'x'.repeat(chunkSizeNum) + '\n';
        }

        const payload = {
            chunkIndex,
            size: chunkData.length,
            content: chunkData,
        };

        sendEvent(res, payload, { event: eventType, id: lastId });

        // Store for resumption
        stored.push({ id: lastId, data: payload });
        if (stored.length > 500) stored.shift(); // prevent unbounded growth

        byteSent += chunkData.length;

        setStoreExpiration(streamId);
    }, delayNum);

    req.on('close', () => {
        clearInterval(interval);
        res.end();
    });
});

if (USE_HTTPS) {
    const options = {
        key: readFileSync('/certs/privkey.pem'), // Path inside container
        cert: readFileSync('/certs/fullchain.pem'),
    };
    createServer(options, app).listen(PORT, () => {
        console.log(
            `Advanced SSE test server running on HTTPS https://localhost:${PORT}`,
        );
    });
} else {
    app.listen(3000, () => {
        console.log(
            `Advanced SSE test server running on HTTP http://localhost:${PORT}`,
        );
    });
}
