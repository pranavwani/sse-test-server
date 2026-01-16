import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import https from 'https';
import fs from 'fs';

const app = express();

const PORT = process.env.PORT || 3000;
const USE_HTTPS = process.env.USE_HTTPS === 'true';

app.use(cors()); // Enable CORS for all routes
app.use(bodyParser.json()); // For parsing POST bodies

// Helper to send SSE-formatted data
function sendEvent(res, data, options = {}) {
    if (options.id) res.write(`id: ${options.id}\n`);
    if (options.event) res.write(`event: ${options.event}\n`);
    if (options.retry) res.write(`retry: ${options.retry}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    res.flushHeaders(); // Ensure data is sent immediately
}

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
        delay,
        largePayload,
        errorAfter,
    } = req.query; // Default to 2s
    let count = 0;
    let lastId = 0;

    // Initial connection message with optional retry
    sendEvent(
        res,
        {
            message: 'Connected to test SSE server',
        },
        { retry, id: ++lastId }
    );

    // Send events periodically
    const streamInterval = setInterval(() => {
        if (count >= maxEvents) {
            res.end();
            return;
        }

        if (errorAfter && count == errorAfter) {
            res.status(500).end('Simulated server error');
            return;
        }

        if (delay) {
            // Simulate delay before next event
            setTimeout(() => sendNextEvent(), parseInt(delay));
        } else {
            sendNextEvent();
        }

        function sendNextEvent() {
            let payload = {
                time: new Date().toISOString(),
                count: ++count,
                message: 'Test event',
            };

            if (largePayload) {
                // Simulate large payload (e.g., 1 MB of data)
                payload.largeData = 'x'.repeat(1024 * 1024);
            }

            sendEvent(res, payload, { event: eventType, id: ++lastId });
        }
    }, parseInt(interval));

    // Handle reconnection (client may send Last-Event-ID header)
    if (req.headers['last-event-id']) {
        sendEvent(
            res,
            { message: `Reconnected after ID ${req.headers['last-event-id']}` },
            { id: ++lastId }
        );
    }

    // Cleanup on client disconnect
    res.on('close', () => {
        clearInterval(streamInterval);
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
                { event: type, id: ++id }
            );
            if (index == 2) res.end();
        }, index * 5000);
    });

    req.on('close', () => res.end());
});

if (USE_HTTPS) {
    const options = {
        key: fs.readFileSync('/certs/cert1.pem'), // Path inside container
        cert: fs.readFileSync('/certs/privkey1.pem'),
    };
    https.createServer(options, app).listen(PORT, () => {
        console.log(
            `Advanced SSE test server running on HTTPS https://localhost:${PORT}`
        );
        console.log(
            '- /sse/test?interval=1000&eventType=custom&retry=5&&maxEvents=10&delay=2---&largePayload=true&errorAfter=5'
        );
        console.log('- POST /sse/echo (send JSON body)');
        console.log('- /sse/error?code=404');
        console.log('- /sse/timeout');
        console.log('- /sse/multi');
    });
} else {
    app.listen(3000, () => {
        console.log(
            `Advanced SSE test server running on HTTP http://localhost:${PORT}`
        );
        console.log(
            '- /sse/test?interval=1000&eventType=custom&retry=5&&maxEvents=10&delay=2---&largePayload=true&errorAfter=5'
        );
        console.log('- POST /sse/echo (send JSON body)');
        console.log('- /sse/error?code=404');
        console.log('- /sse/timeout');
        console.log('- /sse/multi');
    });
}
