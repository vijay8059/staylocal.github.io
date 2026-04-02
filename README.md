# StayLocal 📡

**Cross-platform local-network file transfer — no cloud, no internet upload.**

Transfer files between any device (Windows, macOS, Linux, Android, iOS) on the same WiFi network directly in the browser. Files travel peer-to-peer via WebRTC — they never leave your network.

## Live site
👉 https://vijay8059.github.io/staylocal.github.io/

## Features
- 🔒 **100% private** — files stay on your local network
- ⚡ **Full WiFi speed** — no internet bottleneck  
- 🌐 **Cross-platform** — any device with a modern browser
- 📦 **No install required** — web app works instantly
- ♾️ **No file size limit**
- 🎯 **QR code / link sharing** — one-tap connect

## How it works
1. Open the site on both devices (same WiFi)
2. Scan the QR code or paste the peer code on the second device
3. Drag & drop files to transfer — they download directly

## Tech stack
- **WebRTC / PeerJS** — peer-to-peer data channel (files never touch a server)
- **PeerJS cloud** — used only for the initial signalling handshake (~100 bytes)
- **Vanilla JS + HTML/CSS** — zero build step, works on GitHub Pages

## Project structure
```
index.html        ← landing page + embedded web app
css/style.css     ← styles (dark/light theme)
js/app.js         ← WebRTC transfer logic
```

## Downloads (native apps)
Binary releases are published via [GitHub Releases](https://github.com/vijay8059/staylocal.github.io/releases):

| Platform | File |
|----------|------|
| Windows  | `StayLocal-Setup-win-x64.exe` |
| macOS    | `StayLocal-mac-universal.dmg` |
| Linux    | `StayLocal-linux-x64.AppImage` / `.deb` |
| Android  | `StayLocal-android.apk` |

## License
MIT
