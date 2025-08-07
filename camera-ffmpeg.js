const fs = require("fs");
const http = require('http');
const path = require("path");
const HAP = require("hap-nodejs"); // Use hap-nodejs directly
const {
    Accessory,
    Bridge,
    Service,
    Characteristic,
    CameraController,
    HAPStorage,
    H264Profile,
    H264Level,
    VideoCodecParamProfileIDTypes,
    VideoCodecParamLevelTypes,
    AudioRecordingCodecType,
    AudioRecordingSamplerate,
    AudioBitrate,
    SRTPCryptoSuites,
    uuid,
} = HAP;
const express = require("express");
const WebSocket = require('ws');
const { spawn } = require("child_process"); // For running ffmpeg
const crypto = require("crypto"); // For SRTP keys
const logger = require("./logger"); // logger setup
const QRCode = require("qrcode"); // For web QR code
const generatePin = require("./generatePin");

// Running status
let isRunning = false;

// A simple in-memory circular buffer for the last N log entries
const logBuffer = [];
const MAX_LOG_BUFFER = 200;
const MAX_LOG = 200;

// WebSocket server reference (assigned when the web server starts)
let wss = null;

// Keep the original log method
const origLog = logger.log.bind(logger);

function pushLog(entry){
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG) logBuffer.shift();

  // Broadcast to connected WebSocket clients if the server is running
  if (wss) {
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'log', data: entry }));
      }
    });
  }
}

logger.log = (level, msg) => {
  // 1) Log as usual
  origLog(level, msg);

  // 2) Push to buffer and broadcast
  const entry = { level, message: msg, timestamp: new Date().toISOString() };
  pushLog(entry);
};

// --- Configuration Loading ---
const configPath = path.join(__dirname, "config.json");
let config;
try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    logger.info(`Configuration loaded successfully from ${configPath}`);
} catch (err) {
    logger.error(
        `Failed to load configuration from ${configPath}: ${err.message}`
    );
    process.exit(1);
}

// --- HAP Storage Initialization ---
// node-persist is used internally by hap-nodejs when a custom path is set
const persistPath = path.join(__dirname, config.bridge.persistDir || 'persist');
HAPStorage.setCustomStoragePath(persistPath);

// --- Global Variables ---
let hapBridge;
let publishInfo;
const cameraControllers = new Map(); // Map<cameraUUID, CameraController>
const cameraConfigs = new Map(); // Map<cameraUUID, cameraConfig>
const activeSessions = new Map(); // Map<sessionID, sessionInfo>

// --- Generate Bridge PIN ---
const bridgePin = generatePin(config, logger);

// --- FFmpeg Process Management ---
class FfmpegProcess {
    constructor(cameraName, sessionId, command, logger) {
        this.log = logger;
        this.cameraName = cameraName;
        this.sessionId = sessionId;
        this.command = command;
        this.process = null;
        this.timeout = null;
        this.killed = false;

        this.log.debug(
            `[${this.cameraName}] Starting ffmpeg process for session ${this.sessionId}`
        );
        this.log.debug(
            `[${this.cameraName}] Command: ffmpeg ${this.command.join(" ")}`
        );

        try {
            this.process = spawn("ffmpeg", this.command, { env: process.env });
        } catch (spawnError) {
            this.log.error(
                `[${this.cameraName}] Error spawning ffmpeg: ${spawnError.message}. Is ffmpeg installed and in the system PATH?`
            );
            this.cleanup(); // Ensure cleanup happens even if spawn fails
            throw spawnError; // Re-throw the error to be caught by the caller
        }

        this.process.stdout.on("data", (data) => {
            this.log.debug(
                `[${this.cameraName}] FFmpeg STDOUT: ${data.toString().trim()}`
            );
        });
        this.process.stderr.on("data", (data) => {
            // Reduce noise: only log errors or key messages from stderr
            const stderrLine = data.toString().trim();
            if (
                stderrLine.toLowerCase().includes("error") ||
                stderrLine.toLowerCase().includes("failed") ||
                !stderrLine.startsWith("[")
            ) {
                this.log.debug(
                    `[${this.cameraName}] FFmpeg: ${stderrLine}`
                );
            }
        });
        this.process.on("error", (err) => {
            this.log.error(
                `[${this.cameraName}] FFmpeg process error event: ${err.message}`
            );
            this.cleanup();
        });
        this.process.on("close", (code, signal) => {
            if (this.killed) {
                this.log.debug(
                    `[${this.cameraName}] FFmpeg process stopped intentionally for session ${this.sessionId}.`
                );
            } else if (code === 0) {
                this.log.info(
                    `[${this.cameraName}] FFmpeg process exited normally (code 0) for session ${this.sessionId}.`
                );
            } else {
                this.log.error(
                    `[${this.cameraName}] FFmpeg process exited unexpectedly (code ${code}, signal ${signal}) for session ${this.sessionId}.`
                );
            }
            this.cleanup();
        });
    }

    stop() {
        if (this.process && !this.killed) {
            this.log.debug(
                `[${this.cameraName}] Stopping ffmpeg process for session ${this.sessionId}...`
            );
            this.killed = true;
            this.process.kill("SIGKILL"); // Force kill
        }
        this.cleanup(); // Ensure cleanup runs even if process was already null
    }

    cleanup() {
        if (this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = null;
        }
        // Remove from active sessions map in the main script
        if (activeSessions.has(this.sessionId)) {
            // Check if the process stored in the map is this one before deleting
            const sessionInfo = activeSessions.get(this.sessionId);
            if (sessionInfo && sessionInfo.process === this) {
                sessionInfo.process = null; // Clear process reference in map
                activeSessions.delete(this.sessionId); // Remove session if process is gone
                logger.debug(
                    `Session ${this.sessionId} removed from active sessions.`
                );
            }
        }
        this.process = null; // Release internal reference
    }
}

// --- Camera Delegate Implementation ---

// Gets called when HomeKit wants a snapshot image.
async function handleSnapshotRequest(request, callback) {
    const cameraUUID = this.accessoryUUID; // 'this' is bound in configureController
    const cameraConfig = cameraConfigs.get(cameraUUID);
    if (!cameraConfig) {
        logger.error(`[${cameraUUID}] Config not found for snapshot request.`);
        return callback(new Error("Camera config not found"));
    }

    const width = request.width;
    const height = request.height;
    // Prefer still image source, fallback to main source
    const snapshotInput =
        cameraConfig.videoConfig.stillImageSource || cameraConfig.videoConfig.source;
    if (!snapshotInput) {
        logger.error(
            `[${cameraConfig.name}] No source or stillImageSource defined for snapshot.`
        );
        return callback(new Error("No snapshot source defined"));
    }

    // Construct snapshot command (similar to plugin's ffmpeg.js)
    // Start with input arguments if specified separately
    // let ffmpegOptions = (cameraConfig.videoConfig.inputOptions || "")
    //     .split(" ")
    //     .filter((arg) => arg);

    // Add input source

    // ffmpegOptions.push(snapshotInput);

    // Add output arguments
    // 1) Grab & split your inputOptions exactly as before
    const inputOptions = (cameraConfig.videoConfig.inputOptions || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    // 2) Now parse your source string, whether it’s “-i URL” or just “URL”
    let sourceOptions;
    const src = cameraConfig.videoConfig.source.trim();
    if (src.startsWith('-i ')) {
      // split “-i http://…” into ['-i','http://…']
      sourceOptions = src.split(/\s+/);
    } else {
      // fall back to explicit ['-i', 'URL']
      sourceOptions = ['-i', src];
    }

    // 3) Build the full Options array by concatenating
    const ffmpegOptions = [
      ...inputOptions,
      ...sourceOptions,
    //
    // const ffmpegOptions = [
    //     ...inputOptions,                   // e.g. ["-protocol_whitelist","file,http,…","-f","hls"]
    //     '-i',                           // separate flag
    //     cameraConfig.videoConfig.source,      // separate URL
    // ffmpegOptions.push(
        "-frames:v",
        "1",
        "-s",
        `${width}x${height}`,
        "-f",
        "image2", // Output format
        "-" // Output to stdout
    ];

    logger.debug(
        `[${cameraConfig.name}] Snapshot command: ffmpeg ${ffmpegOptions.join(" ")}`
    );

    const ffmpegStartTime = Date.now();
    let ffmpeg;
    try {
        ffmpeg = spawn("ffmpeg", ffmpegOptions, { env: process.env });
    } catch (spawnError) {
        logger.error(
            `[${cameraConfig.name}] Error spawning snapshot ffmpeg: ${spawnError.message}. Is ffmpeg installed and in the system PATH?`
        );
        return callback(spawnError);
    }

    let imageBuffer = Buffer.alloc(0);
    let errorOutput = "";
    let processClosed = false; // Flag to prevent callback race condition

    const snapshotTimeoutMs =
        (cameraConfig.videoConfig.snapshotTimeout || 5) * 1000; // 5 seconds default
    const timeoutHandle = setTimeout(() => {
        if (!processClosed) {
            logger.warn(
                `[${cameraConfig.name}] Snapshot process timed out after ${
                    snapshotTimeoutMs / 1000
                }s. Killing...`
            );
            ffmpeg.kill("SIGKILL");
            // Callback will be handled by the 'close' event now
        }
    }, snapshotTimeoutMs);

    ffmpeg.stdout.on("data", (data) => {
        imageBuffer = Buffer.concat([imageBuffer, data]);
    });
    ffmpeg.stderr.on("data", (data) => {
        errorOutput += data.toString();
    });
    ffmpeg.on("error", (err) => {
        if (processClosed) return;
        processClosed = true;
        clearTimeout(timeoutHandle);
        logger.error(
            `[${cameraConfig.name}] Snapshot process error event: ${err.message}`
        );
        callback(err); // Report error to HomeKit
    });
    ffmpeg.on("close", (code, signal) => {
        if (processClosed) return;
        processClosed = true;
        clearTimeout(timeoutHandle);
        const duration = (Date.now() - ffmpegStartTime) / 1000;

        if (code === 0) {
            // logger.info(`[${cameraConfig.name}] Snapshot taken successfully (${width}x${height}, ${imageBuffer.length} bytes, ${duration.toFixed(2)}s).`);
            callback(null, imageBuffer);
        } else {
            logger.error(
                `[${
                    cameraConfig.name
                }] Snapshot failed (code ${code}, signal ${signal}, duration ${duration.toFixed(
                    2
                )}s). FFmpeg stderr: ${errorOutput
                    .split("\n")
                    .slice(-5)
                    .join("\n")}`
            ); // Log last few lines of error
            callback(
                new Error(`Snapshot failed (code ${code}, signal ${signal})`)
            );
        }
    });
}

// Gets called when HomeKit is preparing a stream session.
async function prepareStream(request, callback) {
    const cameraUUID = this.accessoryUUID;
    const cameraConfig = cameraConfigs.get(cameraUUID);
    if (!cameraConfig) {
        logger.error(`[${cameraUUID}] Config not found for prepareStream.`);
        // Cannot proceed without config, but callback expects session info structure
        // Sending an error might be better than an empty response.
        return callback(
            new Error("Camera config not found during prepareStream")
        );
    }

    const sessionId = request.sessionID;
    const targetAddress = request.targetAddress; // HomeKit device IP

    // Video setup from request
    const videoPort = request.video.port;
    const videoCryptoSuite = request.video.srtpCryptoSuite; // Should be AES_CM_128_HMAC_SHA1_80 (enum value 0)
    const videoSrtpKey = request.video.srtp_key; // Buffer
    const videoSrtpSalt = request.video.srtp_salt; // Buffer

    // Audio setup (if enabled and requested)
    let audioPort = 0;
    let audioSrtpKey = null;
    let audioSrtpSalt = null;
    let audioCryptoSuite = null; // Typically same as video
    if (cameraConfig.enableAudio && request.audio) {
        audioPort = request.audio.port;
        audioCryptoSuite = request.audio.srtpCryptoSuite;
        audioSrtpKey = request.audio.srtp_key; // Buffer
        audioSrtpSalt = request.audio.srtp_salt; // Buffer
    } else {
        logger.debug(
            `[${cameraConfig.name}] Audio disabled or not requested for session ${sessionId}`
        );
    }

    // Generate the combined SRTP key/salt for FFmpeg (matches plugin's ffmpeg.js)
    // FFmpeg expects Base64 encoded key+salt
    const videoSRTP = Buffer.concat([videoSrtpKey, videoSrtpSalt]);
    const videoSRTPBase64 = videoSRTP.toString("base64");

    let audioSRTPBase64 = null;
    if (audioSrtpKey && audioSrtpSalt) {
        const audioSRTP = Buffer.concat([audioSrtpKey, audioSrtpSalt]);
        audioSRTPBase64 = audioSRTP.toString("base64");
    }

    // Prepare the response object for HomeKit
    // This tells HomeKit where we want it to send RTP/SRTP packets
    const response = {
        // address: targetAddress, // Don't set address here, HAP-NodeJS handles it based on connection
        video: {
            port: videoPort, // Echo the port HomeKit allocated
            ssrc: 1, // Use a fixed SSRC for video
            srtp_key: videoSrtpKey, // Echo the key/salt back
            srtp_salt: videoSrtpSalt,
            srtpCryptoSuite: videoCryptoSuite, // Confirm the suite we'll use
        },
    };

    // Add audio response if applicable
    if (audioPort > 0 && audioSRTPBase64) {
        response.audio = {
            port: audioPort,
            ssrc: 2, // Use a fixed SSRC for audio
            srtp_key: audioSrtpKey,
            srtp_salt: audioSrtpSalt,
            srtpCryptoSuite: audioCryptoSuite,
        };
    }

    // Store session details needed by handleStreamRequest and FFmpeg
    activeSessions.set(sessionId, {
        targetAddress: targetAddress, // IP address of the HomeKit device
        videoPort: videoPort,
        videoSRTP: videoSRTPBase64, // Base64 key+salt for ffmpeg
        videoSSRC: 1,
        audioEnabled: !!(audioPort > 0 && audioSRTPBase64), // Track if audio is active for this session
        audioPort: audioPort,
        audioSRTP: audioSRTPBase64, // Base64 key+salt for ffmpeg
        audioSSRC: 2,
        process: null, // Placeholder for the FfmpegProcess instance
    });

    logger.info(
        `[${cameraConfig.name}] Prepared stream session ${sessionId} for ${targetAddress}`
    );
    callback(null, response); // Send response back to HomeKit
}

// Gets called when HomeKit wants to start/stop the stream.
async function handleStreamRequest(request, callback) {
    const cameraUUID = this.accessoryUUID;
    const cameraConfig = cameraConfigs.get(cameraUUID);
    if (!cameraConfig) {
        logger.error(
            `[${cameraUUID}] Config not found for handleStreamRequest.`
        );
        return callback(new Error("Camera config not found"));
    }

    const sessionId = request.sessionID;

    switch (request.type) {
        case "start": {
            const sessionInfo = activeSessions.get(sessionId);
            if (!sessionInfo) {
                logger.error(
                    `[${cameraConfig.name}] Session ${sessionId} not found for start request.`
                );
                return callback(new Error("Session not found"));
            }
            if (sessionInfo.process) {
                logger.warn(
                    `[${cameraConfig.name}] Stream already started for session ${sessionId}.`
                );
                // Should still call callback() to acknowledge, even if already started
                return callback();
            }

            logger.info(
                `[${cameraConfig.name}] Received request to start stream session ${sessionId}`
            );

            // --- Video parameters from request ---
            // const videoCodec = request.video.codec; // HAP.VideoCodecType enum (usually 0 for H264)
            const videoProfile = request.video.profile; // HAP.VideoCodecParamProfileIDTypes enum
            const videoLevel = request.video.level; // HAP.VideoCodecParamLevelTypes enum
            const videoBitrate = request.video.max_bit_rate; // kbit/s
            const videoFps = request.video.fps;
            const videoWidth = request.video.width;
            const videoHeight = request.video.height;
            const videoPktSize = request.video.mtu || 1316; // Max packet size for RTP

            // --- Audio parameters from request (if session audio is enabled) ---
            let audioCodec = null; // HAP.AudioCodecTypes enum
            let audioBitrate = 0; // kbit/s
            let audioSamplerate = 0; // HAP.AudioSamplerate enum (e.g., KHZ_16, KHZ_24)
            if (sessionInfo.audioEnabled && request.audio) {
                audioCodec = request.audio.codec;
                audioBitrate = request.audio.max_bit_rate;
                audioSamplerate = request.audio.sample_rate; // Numeric value (e.g., 16, 24) corresponding to enum
                logger.debug(
                    `[${cameraConfig.name}] Audio requested: Codec ${audioCodec}, Rate ${audioSamplerate}kHz, Bitrate ${audioBitrate}k`
                );
            }

            // --- Build FFmpeg command (based on plugin's ffmpeg.js logic) ---

            // 1) Grab & split your inputOptions exactly as before
            let ffmpegInputOptions = (cameraConfig.videoConfig.inputOptions || "")
                // .split(" ")
                // .filter((arg) => arg);
                .trim()
                .split(/\s+/)
                .filter(Boolean);
            let ffmpegVideoOptions = [];
            let ffmpegAudioOptions = [];
            let ffmpegOutputOptions = [];

            // --- Input ---
            // Add input source from config
            if (!cameraConfig.videoConfig.source) {
                logger.error(
                    `[${cameraConfig.name}] Missing 'source' in videoConfig.`
                );
                return callback(new Error("Missing 'source' in videoConfig"));
            }
            // ffmpegInputOptions.push(cameraConfig.videoConfig.source);

            // 2) Now parse your source string, whether it’s “-i URL” or just “URL”
            let sourceOptions;
            const src = cameraConfig.videoConfig.source.trim();
            if (src.startsWith('-i ')) {
              // split “-i http://…” into ['-i','http://…']
              sourceOptions = src.split(/\s+/);
            } else {
              // fall back to explicit ['-i', 'URL']
              sourceOptions = ['-i', src];
            }
            ffmpegInputOptions = [... ffmpegInputOptions, ... sourceOptions]

            // --- Video ---
            ffmpegVideoOptions.push(
                "-an", // Disable audio unless explicitly enabled later
                "-sn", // Disable subtitles
                "-vcodec",
                cameraConfig.videoConfig.vcodec || "libx264", // Use configured or default libx264
                "-pix_fmt",
                "yuv420p", // Required pixel format for H.264
                "-color_range",
                "mpeg", // Often needed for HomeKit compatibility on Apple devices
                "-r",
                videoFps.toString(), // Framerate from request
                "-s",
                `${videoWidth}x${videoHeight}`, // Resolution from request
                "-b:v",
                `${videoBitrate}k`, // Target bitrate from request
                "-maxrate",
                `${videoBitrate}k`, // Crucial for smooth streaming
                "-bufsize",
                `${videoBitrate * 2}k`, // Recommended buffer size (2x bitrate)
                "-payload_type",
                request.video.pt.toString() // RTP payload type from request
            );
            // Add profile/level if using libx264 (most common)
            if ((cameraConfig.videoConfig.vcodec || "libx264") === "libx264") {
                const profiles = ["baseline", "main", "high"]; // ffmpeg profile names
                const levels = {
                    // Map HAP levels enum values to ffmpeg level strings
                    [H264Level.LEVEL3_1]: "3.1",
                    [H264Level.LEVEL3_2]: "3.2",
                    [H264Level.LEVEL4_0]: "4.0",
                };
                // Use HAP constants directly here for comparison
                if (videoProfile === H264Profile.BASELINE)
                    ffmpegVideoOptions.push("-profile:v", "baseline");
                else if (videoProfile === H264Profile.MAIN)
                    ffmpegVideoOptions.push("-profile:v", "main");
                else if (videoProfile === H264Profile.HIGH)
                    ffmpegVideoOptions.push("-profile:v", "high");
                // If profile wasn't specified or matched, don't add the flag

                if (levels[videoLevel])
                    ffmpegVideoOptions.push("-level:v", levels[videoLevel]);
                // If level wasn't specified or matched, don't add the flag
            }
            // Add any custom video filter from config
            if (cameraConfig.videoConfig.videoFilter) {
                ffmpegVideoOptions.push("-vf", cameraConfig.videoConfig.videoFilter);
            }

            // --- Audio (if enabled for this session) ---
            if (sessionInfo.audioEnabled && audioCodec !== null) {
                // Find and remove '-an' if it exists
                const anIndex = ffmpegVideoOptions.indexOf("-an");
                if (anIndex > -1) ffmpegVideoOptions.splice(anIndex, 1);

                ffmpegAudioOptions.push("-acodec");
                let audioCodecName = "";
                let audioOptions = [];

                // Map HAP audio codec enums to ffmpeg codec names and options
                if (audioCodec === AudioCodecTypes.OPUS) {
                    audioCodecName = "libopus";
                    audioOptions.push("-application", "lowdelay"); // Good for streaming
                } else if (audioCodec === AudioCodecTypes.AAC_ELD) {
                    // Check common AAC encoders
                    // Prefer libfdk_aac if available (higher quality)
                    // You might need a check here to see if ffmpeg supports it, or just try
                    audioCodecName = "libfdk_aac"; // Or 'aac' if libfdk_aac is not compiled in ffmpeg
                    audioOptions.push("-profile:a", "aac_eld");
                } else {
                    // Fallback or error? Defaulting to OPUS if available
                    logger.warn(
                        `[${cameraConfig.name}] Unsupported audio codec request: ${audioCodec}. Attempting OPUS.`
                    );
                    audioCodecName = "libopus";
                    audioOptions.push("-application", "lowdelay");
                }

                ffmpegAudioOptions.push(audioCodecName);
                ffmpegAudioOptions.push(...audioOptions);

                // Map HAP samplerate enums to numeric values for ffmpeg
                let ar = 0;
                if (audioSamplerate === AudioSamplerate.KHZ_8) ar = 8000;
                else if (audioSamplerate === AudioSamplerate.KHZ_16) ar = 16000;
                else if (audioSamplerate === AudioSamplerate.KHZ_24) ar = 24000;
                // Add more mappings if needed

                if (ar > 0) {
                    ffmpegAudioOptions.push("-ar", ar.toString());
                } else {
                    logger.warn(
                        `[${cameraConfig.name}] Unknown audio sample rate enum value: ${audioSamplerate}. Audio might fail.`
                    );
                }

                ffmpegAudioOptions.push(
                    // '-flags', '+global_header', // May not be needed for RTP Opus/AAC-ELD
                    "-b:a",
                    `${audioBitrate}k`, // Audio bitrate from request
                    "-ac",
                    "1", // Force mono audio (HomeKit requirement)
                    "-payload_type",
                    request.audio.pt.toString() // RTP payload type from request
                );
            }

            // --- Output ---
            // Common flags for RTP output
            ffmpegOutputOptions.push("-f", "rtp");

            // Video SRTP Output (Matches plugin format)
            ffmpegOutputOptions.push(
                // Map video Options first
                "-map",
                "0:v:0", // Assuming video is the first video stream in the input
                `-ssrc`,
                sessionInfo.videoSSRC.toString(),
                `-srtp_out_suite`,
                "AES_CM_128_HMAC_SHA1_80", // Hardcoded suite (matches HAP constant)
                `-srtp_out_params`,
                sessionInfo.videoSRTP, // Base64 key+salt
                `srtp://${sessionInfo.targetAddress}:${sessionInfo.videoPort}?rtcpport=${sessionInfo.videoPort}&pkt_size=${videoPktSize}`
            );
            // Audio SRTP Output (if enabled for this session)
            if (sessionInfo.audioEnabled && audioCodec !== null) {
                ffmpegOutputOptions.push(
                    // Map audio Options second
                    "-map",
                    "0:a:0?", // Assuming audio is the first audio stream, '?' makes it optional if input has no audio
                    `-ssrc`,
                    sessionInfo.audioSSRC.toString(),
                    `-srtp_out_suite`,
                    "AES_CM_128_HMAC_SHA1_80",
                    `-srtp_out_params`,
                    sessionInfo.audioSRTP,
                    `srtp://${sessionInfo.targetAddress}:${sessionInfo.audioPort}?rtcpport=${sessionInfo.audioPort}&pkt_size=188` // Standard audio packet size
                );
            }

            // Combine all Options for the command
            const ffmpegCommand = [
                ...ffmpegInputOptions,
                ...ffmpegVideoOptions,
                ...ffmpegAudioOptions,
                ...ffmpegOutputOptions,
            ];

            // Start the FFmpeg process using our wrapper class
            try {
                const ffmpegProc = new FfmpegProcess(
                    cameraConfig.name,
                    sessionId,
                    ffmpegCommand,
                    logger
                );
                sessionInfo.process = ffmpegProc; // Store the process wrapper in the session map
                logger.info(
                    `[${cameraConfig.name}] Started stream process for session ${sessionId}`
                );
                callback(); // Indicate success to HomeKit *after* attempting to start
            } catch (err) {
                // Error during spawn is handled by FfmpegProcess constructor logging
                logger.error(
                    `[${cameraConfig.name}] Failed to initialize FfmpegProcess for session ${sessionId}.`
                );
                // Ensure session is cleaned up if process failed to start
                if (activeSessions.has(sessionId)) {
                    activeSessions.delete(sessionId);
                }
                callback(err); // Report error back to HomeKit
            }

            break;
        } // End case 'start'

        case "reconfigure":
            // TODO: Handle stream reconfiguration requests if needed (e.g., resolution change)
            // This would involve stopping the current ffmpeg process and starting a new one
            // with the updated parameters from request.video / request.audio
            logger.warn(
                `[${cameraConfig.name}] Stream reconfigure request received for session ${sessionId}, but not implemented.`
            );
            callback(); // Acknowledge, even if not implemented
            break;

        case "stop": {
            const sessionInfo = activeSessions.get(sessionId);
            if (sessionInfo && sessionInfo.process) {
                logger.info(
                    `[${cameraConfig.name}] Received request to stop stream session ${sessionId}`
                );
                sessionInfo.process.stop(); // Stop the ffmpeg process via wrapper
                // FfmpegProcess cleanup method will remove from activeSessions map
            } else {
                logger.warn(
                    `[${cameraConfig.name}] Stop request for non-existent session or process: ${sessionId}`
                );
            }
            // Always acknowledge the stop request
            callback();
            break;
        } // End case 'stop'
    } // End switch
}

// --- Setup Bridge and Cameras ---
function setupBridgeAndCameras() {
    logger.info(`Setting up HAP Bridge: ${config.bridge.name}`);
    const bridgeUUID = uuid.generate(
        "hap.accessories." + config.bridge.name.replace(/\s/g, "-")
    );
    hapBridge = new Bridge(config.bridge.name, bridgeUUID);

    hapBridge
        .getService(Service.AccessoryInformation)
        .setCharacteristic(
            Characteristic.Manufacturer,
            config.bridge.manufacturer || "Standalone Bridge"
        )
        .setCharacteristic(
            Characteristic.Model,
            config.bridge.model || "FFmpeg Bridge"
        )
        .setCharacteristic(
            Characteristic.SerialNumber,
            config.bridge.serialNumber || "BRIDGE-001"
        )
        .setCharacteristic(
            Characteristic.FirmwareRevision,
            config.bridge.firmwareRevision || require("./package.json").version
        );

    // --- Create and add each camera accessory ---
    if (!config.cameras) {
        logger.warn(
            "No cameras defined in config.json. Bridge will start with no accessories."
        );
        return; // Exit setup if no cameras
    }

    config.cameras.forEach((cameraConfig) => {
        logger.info(`- Setting up Camera Accessory: ${cameraConfig.name}`);
        // Validate essential camera config
        if (!cameraConfig.name) {
            logger.error("Camera in config missing 'name'. Skipping.");
            return; // Skip this camera
        }
        if (!cameraConfig.videoConfig || !cameraConfig.videoConfig.source) {
            logger.error(
                `Camera '${cameraConfig.name}' missing 'videoConfig' or 'videoConfig.source'. Skipping.`
            );
            return; // Skip this camera
        }

        const cameraUUID = uuid.generate(
            "hap.accessories." + cameraConfig.name.replace(/\s/g, "-")
        );
        const cameraAccessory = new Accessory(cameraConfig.name, cameraUUID);

        // Store validated config for later access by delegate functions
        cameraConfigs.set(cameraUUID, cameraConfig);

        // *** Define CameraController options using DIRECT hap-nodejs constants ***
        const cameraControllerOptions = {
            cameraStreamCount: cameraConfig.videoConfig.maxStreams || 2, // Max concurrent streams
            // Bind delegate functions, passing accessory UUID via 'this' context
            delegate: {
                handleSnapshotRequest: handleSnapshotRequest.bind({
                    accessoryUUID: cameraUUID,
                }),
                prepareStream: prepareStream.bind({
                    accessoryUUID: cameraUUID,
                }),
                handleStreamRequest: handleStreamRequest.bind({
                    accessoryUUID: cameraUUID,
                }),
            },
            // Define supported streaming capabilities
            streamingOptions: {
                // Use CameraController static properties for streaming constants (as per v0.11.0)
                supportedCryptoSuites: [
                    SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80,
                ],
                video: {
                    // Use CameraController static properties
                    codec: {
                        profiles: [
                            H264Profile.BASELINE,
                            H264Profile.MAIN,
                            H264Profile.HIGH,
                        ],
                        levels: [
                            H264Level.LEVEL3_1,
                            H264Level.LEVEL3_2,
                            H264Level.LEVEL4_0,
                        ],
                    },
                    resolutions: cameraConfig.videoConfig.resolutions || [
                        // Width, Height, framerate - Ordered from lowest to highest is recommended
                        [320, 180, 30],
                        [320, 240, 15], // Apple Watch
                        [320, 240, 30],
                        [480, 270, 30],
                        [480, 360, 30],
                        [640, 360, 30],
                        [640, 480, 30],
                        [1280, 720, 30],
                        [1920, 1080, 30],
                    ],
                },
                // Define audio options IF audio is enabled in config
                audio: cameraConfig.enableAudio
                    ? {
                          // Use CameraController static properties
                          codecs: [
                              {
                                  // Opus is generally preferred if ffmpeg supports it well
                                  type: AudioCodecTypes.OPUS,
                                  samplerate: [
                                      AudioSamplerate.KHZ_24,
                                      AudioSamplerate.KHZ_16,
                                  ], // Offer both common rates
                              },
                              {
                                  type: AudioCodecTypes.AAC_ELD,
                                  samplerate: [AudioSamplerate.KHZ_16], // AAC-ELD typically uses 16kHz
                              },
                          ],
                      }
                    : false, // Set to false if audio disabled
            }, // End streamingOptions
        }; // End cameraControllerOptions

        // Create and configure the CameraController
        const cameraController = new CameraController(cameraControllerOptions);
        cameraAccessory.configureController(cameraController);

        // Store controller instance mapped by UUID (optional, might be useful)
        cameraControllers.set(cameraUUID, cameraController);

        // Set AccessoryInformation for this specific camera
        cameraAccessory
            .getService(Service.AccessoryInformation)
            .setCharacteristic(
                Characteristic.Manufacturer,
                cameraConfig.manufacturer || "Default Manufacturer"
            )
            .setCharacteristic(
                Characteristic.Model,
                cameraConfig.model || "Standalone FFmpeg"
            )
            .setCharacteristic(
                Characteristic.SerialNumber,
                cameraConfig.serialNumber || cameraUUID
            )
            .setCharacteristic(
                Characteristic.FirmwareRevision,
                cameraConfig.firmwareRevision || "1.0.0"
            );

        // Add the camera accessory to the bridge
        hapBridge.addBridgedAccessory(cameraAccessory);
        logger.info(`  Camera '${cameraConfig.name}' added to bridge.`);
    }); // End forEach camera

    // --- Setup Bridge Publishing Info ---
    publishInfo = {
        username:
            config.bridge.username ||
            uuid.generate(config.bridge.name).toUpperCase(), // Use config username or generate
        port: config.bridge.port || 51827, // Use config port or default
        pincode: bridgePin,
        category: HAP.Categories.BRIDGE, // Use HAP constant directly
        setupID: config.bridge.setupID || undefined, // Use config setupID if provided (4 char string)
    };
    logger.info("HAP Bridge and Camera setup complete.");
    logger.info(`Scan the QR code available in the web server with your Home app.`);
    logger.info(`Or enter setup code: ${bridgePin}`);

    // Optional: Generate and log QR code URL if web server is enabled
    // if (config.web?.enabled) {
    // Generate setup URI here to log it, even if web server isn't used for display

    // }
} // --- End setupBridgeAndCameras ---

// --- Optional: Express Web Server for QR Code ---
function setupWebServer() {
    // if (!config.web?.enabled) {
    //     logger.info("Web server for QR code is disabled in config.");
    //     return;
    // }
    if (!hapBridge) {
        logger.error(
            "Cannot start web server before HAP bridge is initialized."
        );
        return;
    }

    const app = express();
    const server = http.createServer(app);
    const port = config.webPort || 8765; // Use config port or default

    // serve index.html
    // app.get("/", async (req, res) => {
    //     const setupURI = hapBridge.setupURI();
    //     const qrData = await QRCode.toDataURL(setupURI);
    //     let html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
    //     html = html
    //         .replace(/{{PIN_CODE}}/g, config.bridge.pin)
    //         .replace(/{{SETUP_URI}}/g, setupURI)
    //         .replace(/{{QR_CODE_DATA_URL}}/g, qrData);
    //     res.send(html);
    // });
    app.get('/', async (req, res) => {
      let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

      // generate QR if running
      const qrData = isRunning
        ? await QRCode.toDataURL(hapBridge.setupURI())
        : '';

      const setupURI = hapBridge.setupURI();

      // inject values
      html = html
        .replace(/{{IS_RUNNING}}/g,       isRunning)
        .replace(/{{IS_RUNNING_TEXT}}/g,  isRunning ? 'Running' : 'Stopped')
        .replace(/{{START_DISABLED}}/g,   isRunning ? 'disabled' : '')
        .replace(/{{STOP_DISABLED}}/g,    !isRunning ? 'disabled' : '')
        .replace(/{{PIN_CODE}}/g,         config.bridge.pin)
        .replace(/{{SETUP_URI}}/g,        setupURI)
        .replace(/{{QR_CODE_DATA_URL}}/g, qrData)
        .replace(/{{CONFIG_JSON}}/g,      JSON.stringify(config, null, 2));

      res.send(html);
    });

    app.get('/icon.png', (req, res) => {
      res.sendFile(path.join(__dirname, 'icon.png'));
    });

    // parse JSON bodies
    app.use(express.json());

    app.post('/save-config', (req, res) => {
      try {
        fs.writeFileSync('./config.json', JSON.stringify(req.body,null,2));
        config = req.body;
        return res.json({ success:true, message:'Config saved' });
      } catch(e){
        return res.status(500).json({ success:false, message:e.message });
      }
    });

    app.get('/reload-config', (req, res) => {
      try {
        config = JSON.parse(fs.readFileSync('./config.json','utf8'));
        return res.json({ success:true, config });
      } catch(e){
        return res.status(500).json({ success:false, message:e.message });
      }
    });

    app.get('/status', async (req, res) => {
      // only generate these if the bridge is up
      const qrData   = isRunning ? await QRCode.toDataURL(hapBridge.setupURI()) : '';
      const setupURI = isRunning ? hapBridge.setupURI() : '';

      res.json({
        isRunning,
        pinCode: config.bridge.pin,
        setupURI: setupURI,
        qrData,
        config
      });
    });

    app.post('/start', (req, res) => {
      if (isRunning) return res.json({ success: true });
      try {
        hapBridge.publish(publishInfo, config.bridge.allowInsecureRequest || false);
        isRunning = true;
        res.json({ success: true });
      } catch (e) {
        logger.error(`Failed to start bridge: ${e.message}`);
        res.status(500).json({ success: false, message: e.message });
      }
    });

    app.post('/stop', (req, res) => {
      if (!isRunning) return res.json({ success: true });
      try {
        hapBridge.unpublish();
        isRunning = false;
        res.json({ success: true });
      } catch (e) {
        logger.error(`Failed to stop bridge: ${e.message}`);
        res.status(500).json({ success: false, message: e.message });
      }
    });

    app.post('/reset', (req, res) => {
      try {
        if (isRunning) {
          hapBridge.unpublish();
          isRunning = false;
        }
        fs.rmSync(persistPath, { recursive: true, force: true });
        res.json({ success: true });
      } catch (e) {
        logger.error(`Failed to reset pairings: ${e.message}`);
        res.status(500).json({ success: false, message: e.message });
      }
    });

    // API: get & post config
    app.get("/api/config", (req, res) => res.json(config));
    app.post("/api/config", (req, res) => {
        fs.writeFileSync(configPath, JSON.stringify(req.body, null, 2));
        config = req.body;
        res.json({ success: true });
    });

    // API: historical logs buffer
    app.get("/api/logs", (req, res) => res.json(logBuffer));

    app.get('/logs', (req, res) => {
      res.send(
        logBuffer.map(e => `${e.timestamp} ${e.level}: ${e.message}`).join('\n')
      );
    });

    // WebSocket server for streaming live logs
    wss = new WebSocket.Server({ server, path: '/ws/logs' });
    wss.on('connection', ws => {
      // Replay buffered log entries to new clients
      logBuffer.forEach(e => ws.send(JSON.stringify({ type: 'log', data: e })));
    });

    // Hook your logger (e.g. winston) to call pushLog and broadcast:
    logger.on('data', entry => {
      pushLog(entry);
      // wss.clients.forEach(c => {
      //   if(c.readyState === WebSocket.OPEN) {
      //     c.send(JSON.stringify({ type:'log', data:entry }));
      //   }
      // });
    });

    // WebSocket for live logs
    // const wss = new WebSocket.Server({ server, path: "/ws/logs" });
    // wss.on("connection", (ws) => {
    //     ws.send(JSON.stringify({ type: "status", message: "Connected" }));
    //     logBuffer.forEach((e) =>
    //         ws.send(JSON.stringify({ type: "log", data: e }))
    //     );
    // });
    // broadcast inside your logger hook:
    // wss.clients.forEach(c => c.send(JSON.stringify({ type:'log', data:entry })));

    server.listen(port, "0.0.0.0", () => {
        // Listen on all interfaces
        // Try to determine a local IP for user convenience
        let serverIp = "YOUR_SERVER_IP"; // Default placeholder
        try {
            const nets = require("os").networkInterfaces();
            for (const name of Object.keys(nets)) {
                for (const net of nets[name]) {
                    // Skip over non-IPv4 and internal (i.e. 127.0.0.1) addresses
                    if (net.family === "IPv4" && !net.internal) {
                        serverIp = net.address;
                        break; // Found one, stop searching
                    }
                }
                if (serverIp !== "YOUR_SERVER_IP") break;
            }
        } catch (ipError) {
            logger.warn(
                "Could not determine local IP address for web server message."
            );
        }
        logger.info(
            `Web server listening at http://${serverIp}:${port}`
        );
    }).on("error", (err) => {
        logger.error(
            `Failed to start web server on port ${port}: ${err.message}`
        );
        if (err.code === "EADDRINUSE") {
            logger.error(
                `Port ${port} is already in use. Choose a different port in config.json (webPort).`
            );
        }
    });
}

// --- Main Execution ---

// 1. Initialize HAP and setup accessories
try {
    setupBridgeAndCameras();
} catch (setupError) {
    // Print full stack so we see the file and line number
    console.error("💥 Bridge setup failed:", setupError);
    process.exit(1);
}

// 2. Check if bridge setup was successful
if (!hapBridge) {
    logger.error("Bridge object was not created during setup. Exiting.");
    process.exit(1);
}
// Check if cameras were configured but none were added (due to config errors)
if (config.cameras?.length > 0 && hapBridge.bridgedAccessories.length === 0) {
    logger.error(
        "Cameras were defined in config, but none were successfully added to the bridge. Check logs for errors. Exiting."
    );
    process.exit(1);
}
// Log if bridge is starting empty because no cameras were configured
if (hapBridge.bridgedAccessories.length === 0) {
    logger.warn(
        "Starting bridge with no camera accessories as none were defined in config.json."
    );
}

// 3. Publish the Bridge
try {
    hapBridge.publish(publishInfo, config.bridge.allowInsecureRequest || false); // Allow insecure requests based on config
    logger.info(
        `Bridge ${config.bridge.name} published with username ${publishInfo.username}.`
    );

try {
        // setupWebServer();
        const setupURI = hapBridge.setupURI(); // Get the setup URI
        logger.info(`Setup URI: ${setupURI}`); // Log the URI itself
        // logger.info(
        //     `Point your phone camera at the QR code available at: http://<YOUR_SERVER_IP>:${
        //         config.webPort || 8765
        //     }`
        // );
    } catch (uriError) {
        logger.error("Failed to generate setup URI:", uriError);
    }

    // 4. Setup the optional web server AFTER publishing (so setupURI is available)
    setupWebServer();

    isRunning = true;
} catch (publishError) {
    logger.error(`Failed to publish bridge: ${publishError.message}`);
    process.exit(1);
}

// --- Graceful Shutdown Handling ---
let shuttingDown = false;
const signalHandler = async (signal, signalNum) => {
    if (shuttingDown) {
        logger.warn("Shutdown already in progress.");
        return;
    }
    shuttingDown = true;

    logger.warn(
        `Received ${signal}. Shutting down HAP bridge and FFmpeg processes...`
    );

    // Stop all active FFmpeg streams
    const sessionsToStop = Array.from(activeSessions.values()); // Get current sessions
    // logger.info(`Stopping ${sessionsToStop.length} active FFmpeg session(s)...`);
    const stopPromises = sessionsToStop.map((sessionInfo) => {
        if (sessionInfo.process) {
            logger.debug(
                `Stopping process for session ${sessionInfo.process.sessionId}`
            );
            try {
                sessionInfo.process.stop();
            } catch (stopErr) {
                logger.error(
                    `Error stopping process for session ${sessionInfo.process.sessionId}: ${stopErr.message}`
                );
            }
        }
        return Promise.resolve(); // Return a promise even if no process
    });

    // Wait briefly for processes to attempt stopping
    await Promise.all(stopPromises);
    await new Promise((resolve) => setTimeout(resolve, 500)); // Give half a second

    // Unpublish the bridge
    if (hapBridge) {
        logger.info("Unpublishing bridge...");
        try {
            // unpublish() is synchronous in current hap-nodejs versions
            hapBridge.unpublish();
            logger.info("Bridge unpublished.");
        } catch (unpublishError) {
            logger.error(
                `Error unpublishing bridge: ${unpublishError.message}`
            );
        }
    }

    // Allow HAP-NodeJS internal cleanup
    await new Promise((resolve) => setTimeout(resolve, 1000));

    logger.warn("Shutdown complete. Exiting.");
    process.exit(128 + signalNum); // Standard exit code for signals
};

process.on("SIGINT", () => signalHandler("SIGINT", 2)); // Ctrl+C
process.on("SIGTERM", () => signalHandler("SIGTERM", 15)); // Termination signal

logger.info("Orca HAP service started. Press CTRL+C to stop.");
