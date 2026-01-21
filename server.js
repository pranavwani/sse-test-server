import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import https from 'https';
import fs from 'fs';

const app = express();

const PORT = process.env.PORT || 3000;
const USE_HTTPS = process.env.USE_HTTPS === 'true';

const storeExpirations = new Map(); // streamId -> timeout ID
const DEFAULT_TLS_MS = 3000000; // 5 min

app.use(cors()); // Enable CORS for all routes
app.use(bodyParser.json()); // For parsing POST bodies

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

/**
 * Global state for all streams
 * 
 * streamId → {
 *  events: array of { id, data, event: string? }   // Stored history for catch-up
 *  timer: NodeJS.Timeout | null                    // Global interval for generating events
 *  
 * }
 */


// Basic test stream: Sends periodic events with optional configs via query params
app.get('/sse/test', (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });

    const {
        interval = 2000,
        eventType,
        retry,
        maxEvents = Infinity,
        largePayload,
        errorAfter,
        streamId = 'default',
    } = req.query; // Default to 2s
    let eventCount = 0;
    let lastId = 0;

    // Initialize store if new
    if (!eventStore.has(streamId)) {
        eventStore.set(streamId, []);
    }

    // Handle reconnection (client may send Last-Event-ID header)
    const lastEventId = req.headers['last-event-id']
        ? parseInt(req.headers['last-event-id'])
        : 0;
    if (lastEventId > 0) {
        const storedEvents = eventStore.get(streamId);
        const resumeFrom =
            storedEvents.findIndex((event) => event.id === lastEventId) + 1;
        // TODO: have to look if all events are streamed successfully and connection fail
        if (resumeFrom > 0) {
            for (let i = resumeFrom; i < storedEvents.length; i++) {
                // Send missed events
                sendEvent(res, storedEvents[i].data, {
                    id: storedEvents[i].id,
                    event: eventType,
                });
            }
            lastId = storedEvents[storedEvents.length - 1]?.id || 0;
            eventCount = lastId; // Sync count
        }

        sendEvent(
            res,
            { message: `Resumed from ID ${lastEventId}, current: ${lastId}` },
            { id: ++lastId, retry },
        );
    } else {
        // Initial connection message with optional retry
        sendEvent(
            res,
            { message: 'Connected to test SSE server' },
            { retry, id: ++lastId },
        );
    }

    // Reset/Start expiration timer on every new connection/reconnection
    setStoreExpiration(streamId);

    // Send events periodically
    const streamInterval = setInterval(() => {
        if (eventCount >= maxEvents) {
            res.end();
            return;
        }

        if (errorAfter && eventCount == errorAfter) {
            res.status(500).end('Simulated server error');
            return;
        }

        sendNextEvent();

        function sendNextEvent() {
            let payload = {
                time: new Date().toISOString(),
                eventCount: ++eventCount,
                message: 'Test event',
            };

            if (largePayload === 'true') {
                // Simulate large payload (e.g., 1 MB of data)
                payload.largeData = 'x'.repeat(1024 * 1024);
            }

            sendEvent(res, payload, { event: eventType, id: ++lastId });

            // Store the event
            const storedEvents = eventStore.get(streamId);
            storedEvents.push({ id: lastId, data: payload });
            if (storedEvents.length > 100) storedEvents.shift(); // Limit size for memory;

            // Reset expiration timer because activity happened
            setStoreExpiration(streamId);
        }
    }, parseInt(interval));

    // Cleanup on client disconnect
    res.on('close', () => {
        clearInterval(streamInterval);
        if (eventCount >= maxEvents) {
            // Stream complete: Flush immediately
            eventStore.delete(streamId);
            storeExpirations.delete(streamId);
        }
        res.end();
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
    setTimeout(() => {
        res.status(408).send('Simulated timeout');
    }, 30000); // 30s delay
});

// Multi-event type stream for testing custom events
app.get('/sse/multi', (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });

    let id = 0;
    ['ping', 'update', 'alert'].forEach((type, index) => {
        setTimeout(() => {
            sendEvent(
                res,
                { message: `Event of type: ${type}` },
                { event: type, id: ++id },
            );
            if (index == 2) res.end();
        }, index * 5000);
    });

    req.on('close', () => res.end());
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
        key: fs.readFileSync('/certs/privkey.pem'), // Path inside container
        cert: fs.readFileSync('/certs/cert.pem'),
    };
    https.createServer(options, app).listen(PORT, () => {
        console.log(
            `Advanced SSE test server running on HTTPS https://localhost:${PORT}`,
        );
        console.log(
            '- /sse/test?interval=1000&eventType=custom&retry=5&&maxEvents=10&delay=2---&largePayload=true&errorAfter=5',
        );
        console.log('- POST /sse/echo (send JSON body)');
        console.log('- /sse/error?code=404');
        console.log('- /sse/timeout');
        console.log('- /sse/multi');
    });
} else {
    app.listen(3000, () => {
        console.log(
            `Advanced SSE test server running on HTTP http://localhost:${PORT}`,
        );
        console.log(
            '- /sse/test?interval=1000&eventType=custom&retry=5&&maxEvents=10&delay=2---&largePayload=true&errorAfter=5',
        );
        console.log('- POST /sse/echo (send JSON body)');
        console.log('- /sse/error?code=404');
        console.log('- /sse/timeout');
        console.log('- /sse/multi');
    });
}
