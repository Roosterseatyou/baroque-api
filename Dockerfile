FROM node:20-alpine

# set working directory
WORKDIR /app

# copy package manifests first for efficient caching
COPY package*.json ./

# install all dependencies (including dev for build step)
RUN npm install

# copy the rest of the application
COPY . .

# netcat for simple TCP waits (used by entrypoint.sh)
RUN apk add --no-cache netcat-openbsd

# ensure entrypoint is executable
RUN chmod +x ./entrypoint.sh || true

ENV NODE_ENV=production

# expose port (adjust if your server uses a different port)
EXPOSE 3000

# start via entrypoint which runs migrations then starts the server
# Ensure the script is run by the shell. The base image may have an ENTRYPOINT
# that runs `node` by default which would try to load the shell script as JS.
CMD ["sh", "./entrypoint.sh"]

