ARG BUILD_FROM
ARG BUILD_VERSION
ARG BUILD_ARCH
FROM ${BUILD_FROM}

LABEL \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.type="addon" \
  io.hass.arch="${BUILD_ARCH}"

# (Optional) ensure locale is set
ENV LANG C.UTF-8

# Install runtime deps (including nodejs/npm for your service)
RUN apk add --no-cache \
  jq \
  nodejs \
  npm \
  ffmpeg

# Create app directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --production

# Copy app source
COPY . .

# Ensure run script is executable
RUN chmod +x run.sh

# Run the add-on
ENTRYPOINT ["/app/run.sh"]