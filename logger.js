// logger.js
const { createLogger, format, transports } = require('winston'); // Example using winston

const logger = createLogger({
  level: 'debug', // Log everything from debug level up
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.printf(info => `[${info.timestamp}] ${info.level.toUpperCase()}: ${info.message}`)
  ),
  transports: [
    new transports.Console() // Output logs to the console
    // Add file transport if needed:
    // new transports.File({ filename: 'camera-ffmpeg.log' })
  ]
});

module.exports = logger;
