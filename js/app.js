/**
 * StayLocal — app.js
 * WebRTC P2P file transfer via PeerJS
 * Files transfer directly over the local network — zero cloud upload.
 */

(function () {
  "use strict";

  /* =========================================================
     Constants & Config
  ========================================================= */
  const CHUNK_SIZE = 64 * 1024; // 64 KB per chunk

  const PEERJS_CONFIG = {
    // Uses the free PeerJS cloud server only for signalling (not data).
    // Actual file data travels peer-to-peer over the local network.
    host: "0.peerjs.com",
    port: 443,
    path: "/",
    secure: true,
    config: {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    },
  };

  /* =========================================================
     State
  ========================================================= */
  let peer = null;
  let conn = null;
  let myPeerId = null;
  let isConnected = false;

  // files being sent: { id: { file, sent, total } }
  const sendQueue = {};
  // files being received: { id: { name, size, mimeType, chunks[], received } }
  const receiveBuffer = {};

  /* =========================================================
     DOM references
  ========================================================= */
  const $ = (id) => document.getElementById(id);

  const elStatusBadge    = $("app-status-badge");
  const elMyPeerId       = $("my-peer-id");
  const elQrContainer    = $("qr-container");
  const elConnectInput   = $("connect-input");
  const elConnectBtn     = $("connect-btn");
  const elPendingSection = $("connection-pending");
  const elTransferSection= $("transfer-section");
  const elConnInfoBar    = $("conn-info-bar");
  const elConnectedPeer  = $("connected-peer-id");
  const elDropZone       = $("drop-zone");
  const elFileInput      = $("file-input");
  const elFileList       = $("file-list");
  const elNoFiles        = $("no-files-msg");
  const elInitSection    = $("init-section");

  /* =========================================================
     Initialise PeerJS
  ========================================================= */
  function initPeer() {
    setStatus("connecting", "Connecting…");

    peer = new Peer(PEERJS_CONFIG);

    peer.on("open", (id) => {
      myPeerId = id;
      elMyPeerId.textContent = id;
      generateQR(id);
      setStatus("idle", "Ready");
      checkAutoConnect();
    });

    peer.on("connection", (c) => {
      // Incoming connection request
      if (isConnected) {
        c.close(); // reject if already connected
        return;
      }
      setupConnection(c);
    });

    peer.on("error", (err) => {
      console.error("PeerJS error:", err);
      if (err.type === "peer-unavailable") {
        toast("Peer not found. Check the code and try again.", "error");
        setStatus("idle", "Ready");
        elConnectBtn.disabled = false;
      } else if (err.type === "network" || err.type === "disconnected") {
        toast("Network error. Reconnecting…", "error");
        setTimeout(initPeer, 3000);
      } else {
        toast("Error: " + err.message, "error");
      }
    });

    peer.on("disconnected", () => {
      if (!isConnected) {
        setStatus("idle", "Reconnecting…");
        peer.reconnect();
      }
    });
  }

  /* =========================================================
     Connection setup (both directions)
  ========================================================= */
  function setupConnection(c) {
    conn = c;
    setStatus("connecting", "Connecting…");

    conn.on("open", () => {
      isConnected = true;
      setStatus("connected", "Connected");
      const remotePeerId = conn.peer;
      elConnectedPeer.textContent = remotePeerId;

      // Show connected UI
      elInitSection.classList.add("hidden");
      elPendingSection.classList.add("hidden");
      elConnInfoBar.classList.remove("hidden");
      elTransferSection.classList.remove("hidden");

      toast("Connected to " + remotePeerId, "success");
      updateURL(null); // clean up URL query param
    });

    conn.on("data", handleIncomingData);

    conn.on("close", () => {
      handleDisconnect();
    });

    conn.on("error", (err) => {
      console.error("Connection error:", err);
      handleDisconnect();
    });
  }

  function handleDisconnect() {
    isConnected = false;
    conn = null;
    setStatus("idle", "Ready");

    elInitSection.classList.remove("hidden");
    elConnInfoBar.classList.add("hidden");
    elTransferSection.classList.add("hidden");
    elConnectBtn.disabled = false;

    toast("Disconnected from peer.", "error");
  }

  /* =========================================================
     Outgoing — Send files
  ========================================================= */
  function sendFiles(files) {
    if (!isConnected || !conn) {
      toast("Not connected to a peer.", "error");
      return;
    }

    Array.from(files).forEach((file) => {
      const fileId = generateId();
      sendQueue[fileId] = { file, sent: 0 };

      // Send metadata
      conn.send({
        type: "file-meta",
        id: fileId,
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream",
      });

      addFileItem(fileId, file.name, file.size, "sending");
      sendNextChunk(fileId);
    });
  }

  function sendNextChunk(fileId) {
    const entry = sendQueue[fileId];
    if (!entry) return;

    const { file, sent } = entry;
    const slice = file.slice(sent, sent + CHUNK_SIZE);

    const reader = new FileReader();
    reader.onload = (e) => {
      if (!conn || !isConnected) return;

      const chunk = e.target.result;
      conn.send({
        type: "file-chunk",
        id: fileId,
        data: chunk,
        offset: sent,
      });

      const newSent = sent + chunk.byteLength;
      sendQueue[fileId].sent = newSent;

      updateFileProgress(fileId, newSent / file.size);

      if (newSent < file.size) {
        // requestIdleCallback schedules the next chunk when the browser is idle,
        // preventing UI jank during large transfers.
        if (typeof requestIdleCallback === "function") {
          requestIdleCallback(() => sendNextChunk(fileId));
        } else {
          setTimeout(() => sendNextChunk(fileId), 0);
        }
      } else {
        conn.send({ type: "file-done", id: fileId });
        updateFileStatus(fileId, "done");
        delete sendQueue[fileId];
      }
    };

    reader.readAsArrayBuffer(slice);
  }

  /* =========================================================
     Incoming — Receive data
  ========================================================= */
  function handleIncomingData(data) {
    if (typeof data !== "object" || !data.type) return;

    switch (data.type) {
      case "file-meta":
        receiveBuffer[data.id] = {
          name: data.name,
          size: data.size,
          mime: data.mime,
          chunks: [],
          received: 0,
        };
        addFileItem(data.id, data.name, data.size, "receiving");
        break;

      case "file-chunk": {
        const buf = receiveBuffer[data.id];
        if (!buf) return;
        buf.chunks.push(data.data);
        buf.received += data.data.byteLength;
        updateFileProgress(data.id, buf.received / buf.size);
        break;
      }

      case "file-done":
        assembleAndDownload(data.id);
        break;

      default:
        break;
    }
  }

  function assembleAndDownload(fileId) {
    const buf = receiveBuffer[fileId];
    if (!buf) return;

    const blob = new Blob(buf.chunks, { type: buf.mime });
    const url = URL.createObjectURL(blob);

    updateFileStatus(fileId, "done");
    attachDownloadButton(fileId, url, buf.name);

    delete receiveBuffer[fileId];
    toast("✔ Received: " + buf.name, "success");
  }

  /* =========================================================
     UI helpers — File list
  ========================================================= */
  function addFileItem(id, name, size, status) {
    elNoFiles.classList.add("hidden");

    const item = document.createElement("div");
    item.className = "file-item";
    item.id = "file-item-" + id;
    item.innerHTML = `
      <div class="file-item-header">
        <span class="file-item-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
        <span class="file-item-size">${formatSize(size)}</span>
        <span class="file-item-status ${status}" id="status-${id}">${statusLabel(status)}</span>
      </div>
      <div class="progress-bar-track">
        <div class="progress-bar-fill" id="prog-${id}" style="width:0%"></div>
      </div>
      <div id="dl-row-${id}"></div>
    `;

    elFileList.appendChild(item);
  }

  function updateFileProgress(id, fraction) {
    const fill = $("prog-" + id);
    if (fill) fill.style.width = Math.min(100, fraction * 100).toFixed(1) + "%";
  }

  function updateFileStatus(id, status) {
    const el = $("status-" + id);
    if (el) { el.className = "file-item-status " + status; el.textContent = statusLabel(status); }
    if (status === "done") updateFileProgress(id, 1);
  }

  function attachDownloadButton(id, url, name) {
    const row = $("dl-row-" + id);
    if (!row) return;
    row.innerHTML = `<div class="received-file-row">
      <a href="${url}" download="${escapeHtml(name)}" class="download-btn">
        ⬇ Save "${escapeHtml(name)}"
      </a>
    </div>`;
  }

  function statusLabel(s) {
    return { sending: "Sending…", receiving: "Receiving…", done: "Done ✔", queued: "Queued" }[s] || s;
  }

  /* =========================================================
     UI helpers — Status badge
  ========================================================= */
  function setStatus(cls, label) {
    elStatusBadge.className = "app-status-badge " + cls;
    elStatusBadge.textContent = label;
  }

  /* =========================================================
     QR Code generation
  ========================================================= */
  function generateQR(peerId) {
    if (!window.QRCode) return;
    elQrContainer.innerHTML = "";
    const shareUrl = buildShareURL(peerId);
    new QRCode(elQrContainer, {
      text: shareUrl,
      width: 108,
      height: 108,
      colorDark: "#6c63ff",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M,
    });
  }

  /* =========================================================
     URL helpers
  ========================================================= */
  function buildShareURL(peerId) {
    const url = new URL(window.location.href);
    url.hash = "";
    url.search = "";
    url.searchParams.set("peer", peerId);
    return url.toString();
  }

  function checkAutoConnect() {
    const params = new URLSearchParams(window.location.search);
    const remotePeer = params.get("peer");
    if (remotePeer && remotePeer !== myPeerId) {
      elConnectInput.value = remotePeer;
      toast("Auto-connecting to " + remotePeer + "…", "");
      connectToPeer(remotePeer);
    }
  }

  function updateURL(peerId) {
    const url = new URL(window.location.href);
    url.searchParams.delete("peer");
    if (peerId) url.searchParams.set("peer", peerId);
    window.history.replaceState({}, "", url.toString());
  }

  /* =========================================================
     Connect button handler
  ========================================================= */
  function connectToPeer(remotePeerId) {
    const peerId = (remotePeerId || elConnectInput.value).trim().toUpperCase();
    if (!peerId) { toast("Enter a peer code.", "error"); return; }
    if (peerId === myPeerId) { toast("That's your own code!", "error"); return; }

    elConnectBtn.disabled = true;
    setStatus("connecting", "Connecting…");

    elInitSection.classList.add("hidden");
    elPendingSection.classList.remove("hidden");

    const c = peer.connect(peerId, { reliable: true, serialization: "binary" });
    setupConnection(c);
  }

  /* =========================================================
     Copy helper
  ========================================================= */
  function copyPeerId() {
    const text = myPeerId;
    if (!text) return;
    navigator.clipboard.writeText(text).then(
      () => toast("Peer ID copied!", "success"),
      () => toast("Copy not supported in this browser. Please copy manually.", "error")
    );
  }

  function copyShareLink() {
    const url = buildShareURL(myPeerId);
    navigator.clipboard.writeText(url).then(
      () => toast("Share link copied!", "success"),
      () => toast("Copy not supported in this browser.", "error")
    );
  }

  /* =========================================================
     Drag & drop / file input
  ========================================================= */
  function initDropZone() {
    elDropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      elDropZone.classList.add("drag-over");
    });
    elDropZone.addEventListener("dragleave", () => elDropZone.classList.remove("drag-over"));
    elDropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      elDropZone.classList.remove("drag-over");
      sendFiles(e.dataTransfer.files);
    });

    elFileInput.addEventListener("change", (e) => {
      if (e.target.files.length) {
        sendFiles(e.target.files);
        e.target.value = "";
      }
    });
  }

  /* =========================================================
     Utilities
  ========================================================= */
  function formatSize(bytes) {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }

  function generateId() {
    return Math.random().toString(36).slice(2, 11).toUpperCase();
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* =========================================================
     Toast notifications
  ========================================================= */
  function toast(message, type) {
    const container = $("toast-container");
    const el = document.createElement("div");
    el.className = "toast " + (type || "");
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => { el.remove(); }, 4000);
  }

  /* =========================================================
     Theme toggle
  ========================================================= */
  function initTheme() {
    const saved = localStorage.getItem("theme") || "dark";
    document.documentElement.setAttribute("data-theme", saved);
    updateThemeBtn(saved);
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
    updateThemeBtn(next);
  }

  function updateThemeBtn(theme) {
    const btn = $("theme-toggle");
    if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
  }

  /* =========================================================
     Disconnect
  ========================================================= */
  function disconnect() {
    if (conn) conn.close();
    handleDisconnect();
  }

  /* =========================================================
     Expose globals for inline handlers
  ========================================================= */
  window.SL = {
    connectToPeer,
    copyPeerId,
    copyShareLink,
    toggleTheme,
    disconnect,
  };

  /* =========================================================
     Boot
  ========================================================= */
  document.addEventListener("DOMContentLoaded", () => {
    initTheme();
    initDropZone();

    // Enter key on connect input
    if (elConnectInput) {
      elConnectInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") connectToPeer();
      });
      // auto-uppercase as user types
      elConnectInput.addEventListener("input", (e) => {
        const cur = e.target.selectionStart;
        e.target.value = e.target.value.toUpperCase();
        e.target.setSelectionRange(cur, cur);
      });
    }

    // Smooth scroll for CTA buttons
    document.querySelectorAll('a[href^="#"]').forEach((a) => {
      a.addEventListener("click", (e) => {
        const target = document.querySelector(a.getAttribute("href"));
        if (target) {
          e.preventDefault();
          target.scrollIntoView({ behavior: "smooth" });
        }
      });
    });

    // Boot PeerJS
    initPeer();
  });
})();
