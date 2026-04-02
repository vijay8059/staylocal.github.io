/**
 * LocalDrop — WebRTC peer-to-peer WiFi file transfer
 * app.js
 *
 * Flow (no server needed — SDP is manually exchanged via copy/paste or QR code):
 *   SENDER:  createOffer → share code/QR → paste receiver's answer → files sent
 *   RECEIVER: paste sender's offer → createAnswer → share code/QR → files arrive
 */

'use strict';

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

const CHUNK_SIZE            = 65536;       // 64 KB per chunk
const MAX_BUFFER            = CHUNK_SIZE * 16; // pause sending when buffer exceeds this
const ICE_GATHERING_TIMEOUT = 12000;       // ms to wait before using partial ICE candidates

const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ]
};

/* ------------------------------------------------------------------ */
/*  State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  peerConnection: null,
  dataChannel:    null,
  selectedFiles:  [],
  // receive state
  recvFileInfo:   null,
  recvChunks:     [],
  recvSize:       0
};

/* ------------------------------------------------------------------ */
/*  DOM helpers                                                         */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hidden');
const hide = (id) => $(id).classList.add('hidden');

/* ------------------------------------------------------------------ */
/*  Tab switching                                                        */
/* ------------------------------------------------------------------ */

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const mode = tab.dataset.mode;
    document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
    $(`${mode}-section`).classList.add('active');
  });
});

/* ------------------------------------------------------------------ */
/*  File selection (SEND side)                                          */
/* ------------------------------------------------------------------ */

const dropzone  = $('dropzone');
const fileInput = $('file-input');

dropzone.addEventListener('click', () => fileInput.click());

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('drag-over');
});

dropzone.addEventListener('dragleave', (e) => {
  if (!dropzone.contains(e.relatedTarget)) {
    dropzone.classList.remove('drag-over');
  }
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  addFiles(Array.from(e.dataTransfer.files));
});

fileInput.addEventListener('change', () => {
  addFiles(Array.from(fileInput.files));
  fileInput.value = ''; // allow re-selecting same file
});

// Event delegation for remove-file buttons (avoids inline onclick)
$('file-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-remove-index]');
  if (btn) removeFile(Number(btn.dataset.removeIndex));
});

// Copy-code buttons (wired up once; IDs are static in index.html)
const copyOfferBtn  = $('copy-offer-btn');
const copyAnswerBtn = $('copy-answer-btn');
if (copyOfferBtn)  copyOfferBtn.addEventListener('click',  () => copyCode('offer-code',  'copy-offer-btn'));
if (copyAnswerBtn) copyAnswerBtn.addEventListener('click', () => copyCode('answer-code', 'copy-answer-btn'));

function addFiles(files) {
  files.forEach((f) => {
    if (!state.selectedFiles.find((x) => x.name === f.name && x.size === f.size)) {
      state.selectedFiles.push(f);
    }
  });
  renderFileList();
}

function removeFile(index) {
  state.selectedFiles.splice(index, 1);
  renderFileList();
}

function renderFileList() {
  const list = $('file-list');
  if (state.selectedFiles.length === 0) {
    list.innerHTML = '';
    $('create-offer-btn').disabled = true;
    return;
  }

  list.innerHTML = state.selectedFiles.map((f, i) => `
    <div class="file-item">
      <span class="file-item-icon">${fileIcon(f.type, f.name)}</span>
      <span class="file-item-name" title="${escHtml(f.name)}">${escHtml(f.name)}</span>
      <span class="file-item-size">${fmtSize(f.size)}</span>
      <button class="file-remove" title="Remove" data-remove-index="${i}">✕</button>
    </div>
  `).join('');

  $('create-offer-btn').disabled = false;
}

/* ------------------------------------------------------------------ */
/*  Utilities                                                           */
/* ------------------------------------------------------------------ */

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function fileIcon(mimeType, name) {
  if (!mimeType && name) {
    const ext = name.split('.').pop().toLowerCase();
    if (['jpg','jpeg','png','gif','bmp','svg','webp','avif'].includes(ext)) return '🖼️';
    if (['mp4','webm','mov','avi','mkv'].includes(ext)) return '🎬';
    if (['mp3','wav','ogg','flac','aac'].includes(ext)) return '🎵';
    if (['pdf'].includes(ext)) return '📄';
    if (['zip','rar','7z','tar','gz'].includes(ext)) return '🗜️';
    if (['doc','docx'].includes(ext)) return '📝';
    if (['xls','xlsx'].includes(ext)) return '📊';
    if (['ppt','pptx'].includes(ext)) return '📊';
    return '📁';
  }
  if (!mimeType) return '📁';
  if (mimeType.startsWith('image/')) return '🖼️';
  if (mimeType.startsWith('video/')) return '🎬';
  if (mimeType.startsWith('audio/')) return '🎵';
  if (mimeType.includes('pdf')) return '📄';
  if (mimeType.includes('zip') || mimeType.includes('x-rar') || mimeType.includes('x-7z') || mimeType.includes('tar')) return '🗜️';
  if (mimeType.includes('word')) return '📝';
  if (mimeType.includes('excel') || mimeType.includes('spreadsheet')) return '📊';
  if (mimeType.includes('powerpoint') || mimeType.includes('presentation')) return '📽️';
  return '📁';
}

function sdpEncode(localDesc) {
  return btoa(JSON.stringify({ type: localDesc.type, sdp: localDesc.sdp }));
}

function sdpDecode(encoded) {
  return JSON.parse(atob(encoded.trim()));
}

function waitForICE(pc) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => resolve(pc.localDescription), ICE_GATHERING_TIMEOUT);

    if (pc.iceGatheringState === 'complete') {
      clearTimeout(deadline);
      return resolve(pc.localDescription);
    }

    pc.addEventListener('icegatheringstatechange', function handler() {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(deadline);
        pc.removeEventListener('icegatheringstatechange', handler);
        resolve(pc.localDescription);
      }
    });

    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate === null) {
        clearTimeout(deadline);
        resolve(pc.localDescription);
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/*  QR Code generator                                                   */
/* ------------------------------------------------------------------ */

function generateQR(containerId, text) {
  const el = $(containerId);
  if (!el) return;
  el.innerHTML = '';

  if (typeof QRCode === 'undefined') {
    el.innerHTML = '<p class="qr-too-long">QR library not loaded. Use the copy button below.</p>';
    return;
  }

  try {
    new QRCode(el, {
      text,
      width: 200,
      height: 200,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.L
    });
  } catch (_) {
    el.innerHTML = '<p class="qr-too-long">Code too long for QR — use the Copy button below.</p>';
  }
}

/* ------------------------------------------------------------------ */
/*  Copy button                                                         */
/* ------------------------------------------------------------------ */

function copyCode(textareaId, btnId) {
  const textarea = $(textareaId);
  const btn = $(btnId);
  const orig = btn.innerHTML;

  navigator.clipboard.writeText(textarea.value).then(() => {
    btn.innerHTML = '✅ Copied!';
    setTimeout(() => { btn.innerHTML = orig; }, 2000);
  }).catch(() => {
    btn.innerHTML = '⚠️ Copy failed';
    setTimeout(() => { btn.innerHTML = orig; }, 2500);
  });
}

/* ------------------------------------------------------------------ */
/*  SENDER — Step 1: Create Offer                                       */
/* ------------------------------------------------------------------ */

$('create-offer-btn').addEventListener('click', async () => {
  const btn = $('create-offer-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Generating…';

  try {
    state.peerConnection = new RTCPeerConnection(ICE_CONFIG);
    state.dataChannel = state.peerConnection.createDataChannel('files', { ordered: true });
    state.dataChannel.bufferedAmountLowThreshold = MAX_BUFFER / 2;

    const offer = await state.peerConnection.createOffer();
    await state.peerConnection.setLocalDescription(offer);

    const descWithICE = await waitForICE(state.peerConnection);
    const code = sdpEncode(descWithICE);

    $('offer-code').value = code;
    generateQR('offer-qr', code);

    hide('send-step-1');
    show('send-step-2');
    show('send-step-3');
  } catch (err) {
    console.error('createOffer error:', err);
    alert('Failed to create connection code. Check console for details.');
    btn.disabled = false;
    btn.innerHTML = '🔗 Create Connection Code';
  }
});

/* ------------------------------------------------------------------ */
/*  SENDER — Step 3: Accept Receiver's Answer & Send                   */
/* ------------------------------------------------------------------ */

$('connect-send-btn').addEventListener('click', async () => {
  const answerCode = $('answer-input').value.trim();
  if (!answerCode) {
    alert('Please paste the response code from the receiving device.');
    return;
  }

  const btn = $('connect-send-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Connecting…';

  try {
    const answerDesc = sdpDecode(answerCode);
    await state.peerConnection.setRemoteDescription(answerDesc);
  } catch (err) {
    console.error('setRemoteDescription error:', err);
    alert('Invalid response code. Please try again.');
    btn.disabled = false;
    btn.innerHTML = '📤 Connect & Send Files';
    return;
  }

  // Wait for data channel to open then start sending
  state.dataChannel.addEventListener('open', async () => {
    hide('send-step-3');
    show('send-step-4');
    await sendAllFiles();
  });

  state.dataChannel.addEventListener('error', (e) => {
    console.error('DataChannel error:', e);
  });
});

/* ------------------------------------------------------------------ */
/*  SENDER — File Transfer                                              */
/* ------------------------------------------------------------------ */

async function sendAllFiles() {
  const container = $('send-progress');
  container.innerHTML = `<div class="transfer-list" id="send-transfer-list"></div>`;

  for (let i = 0; i < state.selectedFiles.length; i++) {
    const file = state.selectedFiles[i];
    const itemId = `send-item-${i}`;

    $('send-transfer-list').insertAdjacentHTML('beforeend', `
      <div class="transfer-item" id="${itemId}">
        <div class="transfer-item-header">
          <span class="transfer-item-name">${fileIcon(file.type, file.name)} ${escHtml(file.name)}</span>
          <span class="transfer-item-status" id="${itemId}-status">0%</span>
        </div>
        <div class="progress-bar-wrap">
          <div class="progress-bar" id="${itemId}-bar"></div>
        </div>
      </div>
    `);

    await sendFile(file, itemId);
  }

  $('send-transfer-list').insertAdjacentHTML('beforeend', `
    <div class="success-banner">✅ All files sent successfully!</div>
  `);
}

function sendFile(file, itemId) {
  return new Promise((resolve) => {
    const dc = state.dataChannel;
    let offset = 0;

    // Send metadata
    dc.send(JSON.stringify({ __type: 'meta', name: file.name, size: file.size, mimeType: file.type || '' }));

    function pump() {
      if (offset >= file.size) {
        dc.send(JSON.stringify({ __type: 'done' }));
        const bar = $(`${itemId}-bar`);
        if (bar) { bar.style.width = '100%'; bar.classList.add('done'); }
        const st = $(`${itemId}-status`);
        if (st) { st.textContent = '✅ Done'; st.style.color = 'var(--success)'; }
        resolve();
        return;
      }

      // Flow-control: pause if buffer is full
      if (dc.bufferedAmount > MAX_BUFFER) {
        dc.addEventListener('bufferedamountlow', function onLow() {
          dc.removeEventListener('bufferedamountlow', onLow);
          pump();
        });
        return;
      }

      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const reader = new FileReader();
      reader.onload = (e) => {
        const chunk = e.target.result;
        dc.send(chunk);
        offset += chunk.byteLength;

        const pct = Math.min(100, Math.round((offset / file.size) * 100));
        const bar = $(`${itemId}-bar`);
        const st  = $(`${itemId}-status`);
        if (bar) bar.style.width = `${pct}%`;
        if (st)  st.textContent = `${pct}%`;

        pump();
      };
      reader.readAsArrayBuffer(slice);
    }

    pump();
  });
}

/* ------------------------------------------------------------------ */
/*  RECEIVER — Step 1: Create Answer                                    */
/* ------------------------------------------------------------------ */

$('create-answer-btn').addEventListener('click', async () => {
  const offerCode = $('offer-input').value.trim();
  if (!offerCode) {
    alert("Please paste the sender's connection code.");
    return;
  }

  const btn = $('create-answer-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Generating…';

  try {
    state.peerConnection = new RTCPeerConnection(ICE_CONFIG);

    // Set up data-channel receiver
    state.peerConnection.addEventListener('datachannel', (event) => {
      setupReceiveChannel(event.channel);
    });

    const offerDesc = sdpDecode(offerCode);
    await state.peerConnection.setRemoteDescription(offerDesc);

    const answer = await state.peerConnection.createAnswer();
    await state.peerConnection.setLocalDescription(answer);

    const descWithICE = await waitForICE(state.peerConnection);
    const code = sdpEncode(descWithICE);

    $('answer-code').value = code;
    generateQR('answer-qr', code);

    hide('recv-step-1');
    show('recv-step-2');
  } catch (err) {
    console.error('createAnswer error:', err);
    alert("Invalid connection code — make sure you copied it completely.");
    btn.disabled = false;
    btn.innerHTML = '🔗 Generate Response Code';
  }
});

/* ------------------------------------------------------------------ */
/*  RECEIVER — Data Channel                                             */
/* ------------------------------------------------------------------ */

function setupReceiveChannel(channel) {
  state.dataChannel = channel;
  channel.binaryType = 'arraybuffer';

  channel.addEventListener('message', (e) => {
    if (typeof e.data === 'string') {
      const msg = JSON.parse(e.data);

      if (msg.__type === 'meta') {
        // Start of a new file
        state.recvFileInfo = msg;
        state.recvChunks   = [];
        state.recvSize     = 0;

        hide('recv-step-2');
        show('recv-step-3');

        const itemId = `recv-item-${Date.now()}`;
        state.recvFileInfo._itemId = itemId;

        $('recv-files').insertAdjacentHTML('beforeend', `
          <div class="transfer-item" id="${itemId}">
            <div class="transfer-item-header">
              <span class="transfer-item-name">
                ${fileIcon(msg.mimeType, msg.name)} ${escHtml(msg.name)}
                <span class="text-muted" style="font-weight:400">(${fmtSize(msg.size)})</span>
              </span>
              <span class="transfer-item-status" id="${itemId}-status">0%</span>
            </div>
            <div class="progress-bar-wrap">
              <div class="progress-bar" id="${itemId}-bar"></div>
            </div>
            <div id="${itemId}-actions" class="mt-12"></div>
          </div>
        `);

      } else if (msg.__type === 'done') {
        // Assemble and offer download
        const info   = state.recvFileInfo;
        const blob   = new Blob(state.recvChunks, { type: info.mimeType || 'application/octet-stream' });
        const url    = URL.createObjectURL(blob);
        const itemId = info._itemId;

        const bar = $(`${itemId}-bar`);
        const st  = $(`${itemId}-status`);
        if (bar) { bar.style.width = '100%'; bar.classList.add('done'); }
        if (st)  { st.textContent = '✅ Done'; st.style.color = 'var(--success)'; }

        const actions = $(`${itemId}-actions`);
        if (actions) {
          actions.innerHTML = `
            <a href="${url}" download="${escHtml(info.name)}" class="download-link">
              ⬇️ Download ${escHtml(info.name)}
            </a>
          `;
        }

        // Reset state for next file
        state.recvChunks   = [];
        state.recvSize     = 0;
        state.recvFileInfo = null;
      }

    } else {
      // Binary chunk
      if (!state.recvFileInfo) return;
      state.recvChunks.push(e.data);
      state.recvSize += e.data.byteLength;

      const info   = state.recvFileInfo;
      const pct    = Math.min(100, Math.round((state.recvSize / info.size) * 100));
      const itemId = info._itemId;
      const bar = $(`${itemId}-bar`);
      const st  = $(`${itemId}-status`);
      if (bar) bar.style.width = `${pct}%`;
      if (st)  st.textContent = `${pct}%`;
    }
  });

  channel.addEventListener('error', (e) => console.error('Recv channel error:', e));
}
