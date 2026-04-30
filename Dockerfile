FROM node:18-alpine

WORKDIR /app

# Copy dependency files
COPY package*.json ./

# Install dependencies
RUN npm install --legacy-peer-deps

# Copy the rest of the backend code
COPY . .

# Expose the port your backend uses (usually 5000 or 8080)
EXPOSE 10000

CMD ["node", "server.js"]
