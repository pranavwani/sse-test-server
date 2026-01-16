# Use official Node.js LTS image (lightweight, secure)
FROM node:18-alpine

# Set working directory inside container
WORKDIR /app

# Copy package.json and install dependencies first (caching layer)
COPY package.json package-lock.json* ./
RUN npm install --production # Only prod deps for smaller image

# Copy the rest of the code
COPY . .

# Expose the port (map it dynamically)
EXPOSE 3000

# Run the app
CMD ["npm", "start"] # Or ["node", "server.js"] if no start script