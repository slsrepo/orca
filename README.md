# Orca

**Orca** is a lightweight, standalone HomeKit-compatible camera bridge powered by FFmpeg. It lets you expose any FFmpeg-compatible video source to Apple HomeKit as a camera accessory, with live streaming and snapshots.


## 🚀 Installation

1. **Clone the repository**  
   ```bash
   git clone https://github.com/slsrepo/orca.git
   cd orca
   ```

2. **Install dependencies**  
   ```bash
   npm install
   ```

3. **Configure**  
   - Copy `options.json` → `config.json`  
   - Edit `config.json` (see next section for details)

4. **Start the service**  
   ```bash
   npm start
   ```
   By default, Orca will:  
   - Load `config.json`  
   - Publish a HomeKit bridge named “Orca Camera Bridge”  
   - Spin up a web UI on `http://<YOUR_SERVER_IP>:8765`


## ⚙️ Configuration (`config.json`)

```jsonc
{
  "bridge": {
    "name": "Orca Camera Bridge",      // Display name in Home app
    "pin": "031-45-154",               // HomeKit pairing PIN
    "manufacturer": "Orca",
    "model": "Standalone Camera Server",
    "serialNumber": "ORCA-001",
    "firmwareRevision": "1.0.0",
    "setupID": "ORCA"
  },
  "webPort": 8765,                     // Port for the web UI (QR code, logs, config)
  "hapPort": 51827,                    // Port for HomeKit HAP traffic
  "debug": true,                       // Enable verbose logging
  "cameras": [
    {
      "name": "Front Door Cam",        // Shown in Home app
      "manufacturer": "Orca",
      "model": "FFmpeg HLS",
      "serialNumber": "ORCA-CAM-001",
      "firmwareRevision": "1.0.0",
      "enableAudio": false,           // HomeKit two-way audio (experimental)
      "videoConfig": {
        "source": "-i rtsp://user:pass@192.168.1.50:554/stream",
        "inputOptions": "-rtsp_transport tcp -analyzeduration 1000",
        "stillImageSource": "-i http://192.168.1.50/snapshot.jpg",
        "maxStreams": 2,
        "maxWidth": 1280,
        "maxHeight": 720,
        "maxFPS": 30,
        "maxBitrate": 600,            // kbit/s
        "packetSize": 1316,
        "vcodec": "libx264",
        "videoFilter": "none",
        "encoderOptions": "-preset ultrafast -tune zerolatency",
        "mapvideo": "0:v:0",
        "mapaudio": "0:a:0",
        "debug": false,
        "resolutions": [
          [320, 240, 15],
          [640, 480, 30],
          [1280, 720, 30]
        ],
        "ffmpegPath": "/usr/local/bin/ffmpeg"
      }
    }
  ]
}
```

### Top-Level Fields

| Key         | Type    | Description                                                          |
|-------------|---------|----------------------------------------------------------------------|
| `bridge`    | object  | HomeKit bridge identity: name, PIN, manufacturer, model, etc.|
| `webPort`   | number  | Port for the web UI (QR code, live logs, config editor).             |
| `hapPort`   | number  | Port for HomeKit HAP protocol.                                       |
| `debug`     | boolean | Enable verbose FFmpeg and internal logging.                          |
| `cameras`   | array   | List of camera accessories to expose.                                |


### `bridge` and `cameras` Properties

| Key                 | Type    | Description                                                                     |
|---------------------|---------|---------------------------------------------------------------------------------|
| `name`              | string  | Display name in Home app.                                                       |
| `pin`               | string  | HomeKit pairing PIN (XXX-XX-XXX).                                               |
| `manufacturer`      | string  | Bridge manufacturer string.                                                     |
| `model`             | string  | Bridge model string.                                                            |
| `serialNumber`      | string  | Unique serial number.                                                           |
| `firmwareRevision`  | string  | Firmware version string.                                                        |
| `persistDir`        | string  | Directory for HAP persistence data. Defaults to "persist".                      |
| `setupID`           | string  | 4-char setup ID for QR code. This key is for `bridge` only.                     |
| `enableAudio`       | boolean | Expose audio via HomeKit (experimental). This key is for `cameras` only.        |

### Camera `videoConfig` Properties

| Key                | Type       | Description                                                                  |
|--------------------|------------|------------------------------------------------------------------------------|
| `source`           | string     | FFmpeg input options (e.g. `-i rtsp://…`).                                   |
| `inputOptions`     | string     | Additional FFmpeg flags for input.                                           |
| `stillImageSource` | string     | FFmpeg input for grabbing a snapshot (optional).                             |
| `ffmpegPath`       | string     | Full path to `ffmpeg` binary (optional).                                     |
| `maxStreams`       | integer    | Concurrent streams allowed.                                                  |
| `maxWidth`         | integer    | Max video width. Set to 0 to allow any.                                      |
| `maxHeight`        | integer    | Max video height. Set to 0 to allow any.                                     |
| `maxFPS`           | integer    | Max frames per second.                                                       |
| `maxBitrate`       | integer    | Max bitrate in kbit/s.                                                       |
| `packetSize`       | integer    | RTP packet size; multiple of 188 (typical 1316).                             |
| `vcodec`           | string     | Video codec (e.g. `libx264`, `copy`).                                        |
| `videoFilter`      | string     | FFmpeg video filters (e.g. `none`, `scale=…`).                               |
| `encoderOptions`   | string     | FFmpeg encoder options (e.g. `-preset ultrafast -tune zerolatency`).         |
| `mapvideo`         | string     | FFmpeg `-map` for video stream (e.g. `0:v:0`).                               |
| `mapaudio`         | string     | FFmpeg `-map` for audio stream (optional).                                   |
| `debug`            | boolean    | Log FFmpeg process output to console.                                        |
| `resolutions`      | array      | List of `[width, height, fps]` triplets supported by HomeKit.                |


## 🔧 Usage

- **Web UI** on `http://<server_ip>:<webPort>`  
  - View/set config  
  - Live logs & snapshots  
  - QR / pairing code

- **Home App**  
  - Scan the displayed QR code or enter the PIN  
  - Enjoy live video, motion/doorbell snapshots, and HomeKit automations

##

© All Rights Reserved, [Sl's Repository Ltd](https://slsrepo.com), 2025.
