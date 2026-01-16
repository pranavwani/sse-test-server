### How to Start the Server (Local and Prod)

#### Local Development (Without Docker)
- **Prerequisites**: Node.js 18+ installed.
- Clone the repo: `git clone <your-repo-url> && cd sse-test-server`
- Install dependencies: `npm install`
- Run: `node server.js`
  - Access at `http://localhost:3000/sse/test` (or other endpoints).
- For HTTPS locally (testing only): Place `cert.pem` and `key.pem` in a `/certs` folder, then run with env vars: `USE_HTTPS=true PORT=3000 node server.js`

#### Local with Docker
- **Prerequisites**: Docker installed.
- Build image: `docker build -t sse-test-server .`
- Run container: 
  ```
  docker run -d \
    --name sse-test \
    -p 3000:3000 \
    -v $(pwd)/certs:/certs:ro \  # Mount certs if using HTTPS
    -e PORT=3000 \
    -e USE_HTTPS=true \  # Optional for HTTPS
    sse-test-server
  ```
- Access at `http://localhost:3000/sse/test` (or `https://localhost:3000` if HTTPS enabled).
- Logs: `docker logs sse-test`
- Stop: `docker stop sse-test && docker rm sse-test`

#### Production Deployment (With Docker)
- **Prerequisites**: Docker on a VM/server (e.g., AWS EC2, DigitalOcean). SSL certs ready.
- Push image to a registry (optional, e.g., Docker Hub): `docker push yourusername/sse-test-server`
- On prod server: Pull/build image, then run:
  ```
  docker run -d \
    --name sse-test \
    -p 443:3000 \  # Expose on standard HTTPS port
    -v /path/to/certs:/certs:ro \
    -e PORT=3000 \
    -e USE_HTTPS=true \
    --restart unless-stopped \  # Auto-restart on crashes
    sse-test-server
  ```
- Firewall: Open port 443 (e.g., `ufw allow 443` on Ubuntu).
- Monitoring: Use `docker stats` or tools like Prometheus.
- Scaling: For high traffic, use Docker Swarm or Kubernetes. Add Redis via Docker Compose for persistent storage.

#### Using Docker Compose (For Multi-Service, e.g., with Redis Later)
Create `docker-compose.yml`:
```yaml
version: '3.9'
services:
  sse-server:
    build: .
    container_name: sse-test
    ports:
      - "443:3000"
    volumes:
      - /path/to/certs:/certs:ro
    environment:
      - PORT=3000
      - USE_HTTPS=true
    restart: unless-stopped

  # Add Redis if needed later
  # redis:
  #   image: redis:alpine
  #   ports:
  #     - "6379:6379"
```
- Start: `docker compose up -d`
- Stop: `docker compose down`