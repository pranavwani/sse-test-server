# SSE Test Server

Lightweight Node.js server for testing Server-Sent Events (SSE). Perfect for validating proxies, clients, reconnections, errors, large payloads, and simulated file streams.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- Periodic SSE streams with configurable interval, event types, retry, max events
- Simulated file streaming (custom size, chunk size, delay, format: text/jsonl/binary)
- Reconnection support via `Last-Event-ID` (in-memory resumption)
- Error, timeout, and echo endpoints
- HTTPS support with custom certs

## Quick Start

```bash
# Clone & run locally
git clone <your-repo-url>
cd sse-test-server
npm install
node server.js
```

→ Test: `new EventSource('http://localhost:3000/sse/test?interval=1000')`

## Docker (Recommended)

```bash
# Build
docker build -t sse-test-server .

# Run (HTTP)
docker run -d -p 3000:3000 sse-test-server

# Run (HTTPS - mount your certs)
docker run -d -p 443:3000 \
  -v /path/to/certs:/certs:ro \
  -e USE_HTTPS=true \
  --restart unless-stopped \
  sse-test-server
```

## API Endpoints & Examples

See full OpenAPI spec in [`openapi.yaml`](openapi.yaml).

Quick examples:

```bash
# Basic stream
/sse/test?interval=500&maxEvents=10

# Simulated 5MB slow file stream
/sse/stream-file?totalBytes=5242880&chunkSize=8192&delayMs=200&format=jsonl

# Echo POST data as SSE
POST /sse/echo with JSON body
```

## Development

- Add new features in `server.js`
- Update `openapi.yaml` when changing API
- Use Postman: Import `openapi.yaml` for auto-generated collection

## License

MIT – see [LICENSE](LICENSE) for full details.
