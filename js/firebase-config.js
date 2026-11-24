/**
 * firebase-config.js
 * 三模混合同步管理器：
 * 1. BroadcastChannel：同裝置跨頁籤零延遲本地同步 (含 Blob 傳輸)
 * 2. WebRTC P2P (PeerJS)：跨裝置免設定點對點即時同步與大檔案影片分片串流
 * 3. Firebase Realtime Database：選配雲端同步 (支援跨網域防火牆備援)
 */

// 預設 Firebase 設定 (使用者可於 UI 介面點擊「設定」隨時更換)
const DEFAULT_FIREBASE_CONFIG = {
  apiKey: "",
  authDomain: "",
  databaseURL: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};

const CHUNK_SIZE = 14 * 1024; // WebRTC 跨瀏覽器安全分片大小 (14 KB，嚴格低於 16 KB SCTP 上限)
const READ_BLOCK_SIZE = 512 * 1024; // 每次從檔案預讀 512 KB 區塊，大幅減少手機 I/O 次數
const MAX_BUFFERED_AMOUNT = 256 * 1024; // 背壓門檻 (256 KB)

let peerJsLoaderPromise = null;
function loadPeerJS() {
  if (typeof window !== "undefined" && window.Peer) {
    return Promise.resolve(window.Peer);
  }
  if (!peerJsLoaderPromise) {
    peerJsLoaderPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js";
      script.async = true;
      script.onload = () => {
        if (window.Peer) resolve(window.Peer);
        else reject(new Error("PeerJS 載入後未定義"));
      };
      script.onerror = () => {
        peerJsLoaderPromise = null;
        reject(new Error("PeerJS CDN 載入失敗"));
      };
      document.head.appendChild(script);
    });
  }
  return peerJsLoaderPromise;
}

export class SyncManager {
  constructor(screenId, role = "screen") {
    this.screenId = screenId;
    this.role = role; // "screen" | "mobile"
    this.isFirebaseReady = false;
    this.firebaseApp = null;
    this.db = null;

    // P2P 狀態
    this.peer = null;
    this.p2pConnections = new Set();
    this.p2pConnected = false;
    this.p2pStatus = "connecting"; // "connecting" | "connected" | "unavailable" | "error"
    this.p2pRetryTimer = null;
    this.destroyed = false;

    // 接收端分片重組暫存 & 去重
    this.incomingVideos = new Map();
    this.completedVideoIds = new Set();

    // 發送端影片快取狀態 (避免重複傳輸同一份影片)
    this.activeTransferId = null;

    // 回呼註冊器
    this.callbacks = {
      status: [],
      displayOpts: [],
      physicsData: [],
      drawEvents: [],
      videoReceive: [],
      connection: []
    };

    this.initLocalChannel();
    this.loadFirebaseConfig();
    this.initP2P();
  }

  initLocalChannel() {
    if (this.bc) {
      try { this.bc.close(); } catch (e) {}
    }
    this.channelName = `physics_tracker_${this.screenId}`;
    this.bc = new BroadcastChannel(this.channelName);
    this.setupBroadcastChannel();
  }

  /**
   * 切換房間 PIN 碼並重新連線所有通道
   */
  setScreenId(newScreenId) {
    if (!newScreenId || newScreenId === this.screenId) return;
    this.screenId = newScreenId;
    this.completedVideoIds.clear();
    this.incomingVideos.clear();
    this.initLocalChannel();
    if (this.isFirebaseReady) {
      this.listenToFirebase();
    }
    this.destroyP2P();
    this.initP2P();
  }

  setupBroadcastChannel() {
    this.bc.onmessage = (event) => {
      const { type, data } = event.data || {};
      if (!type) return;

      if (type === "STATUS_UPDATE") {
        this.triggerCallbacks("status", data);
      } else if (type === "DISPLAY_OPTS_UPDATE") {
        this.triggerCallbacks("displayOpts", data);
      } else if (type === "PHYSICS_DATA_UPDATE") {
        this.triggerCallbacks("physicsData", data);
      } else if (type === "DRAW_EVENT") {
        this.triggerCallbacks("drawEvents", data);
      } else if (type === "VIDEO_BLOB") {
        this.handleLocalVideoBlob(data);
      }
    };

    // 啟動時讀取快照以防跨頁籤開啟時序差
    const snapshotScreenId = this.screenId;
    setTimeout(() => {
      if (this.destroyed || this.screenId !== snapshotScreenId) return;
      try {
        const savedData = localStorage.getItem(`physics_data_${this.screenId}`);
        if (savedData) this.triggerCallbacks("physicsData", JSON.parse(savedData));

        const savedStatus = localStorage.getItem(`physics_status_${this.screenId}`);
        if (savedStatus) this.triggerCallbacks("status", JSON.parse(savedStatus));

        const savedOpts = localStorage.getItem(`physics_opts_${this.screenId}`);
        if (savedOpts) this.triggerCallbacks("displayOpts", JSON.parse(savedOpts));
      } catch (e) {}
    }, 100);
  }

  handleLocalVideoBlob(data) {
    if (!data || !data.blob) return;
    if (data.id && this.completedVideoIds.has(data.id)) return;
    if (data.id) this.completedVideoIds.add(data.id);

    const url = URL.createObjectURL(data.blob);
    this.triggerCallbacks("videoReceive", {
      state: "complete",
      percent: 100,
      id: data.id,
      name: data.name || "video.mp4",
      blob: data.blob,
      url
    });
  }

  // --- WebRTC P2P (PeerJS) 跨裝置零設定直連 ---

  async initP2P() {
    if (this.destroyed) return;
    this.p2pStatus = "connecting";
    this.emitConnectionState();

    try {
      const Peer = await loadPeerJS();
      if (this.destroyed) return;

      const peerOptions = {
        debug: 0,
        config: {
          iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
            { urls: "stun:stun2.l.google.com:19302" }
          ]
        }
      };

      const targetScreenPeerId = `pt-screen-${this.screenId}`;
      const peer = this.role === "screen"
        ? new Peer(targetScreenPeerId, peerOptions)
        : new Peer(undefined, peerOptions);

      this.peer = peer;

      peer.on("open", () => {
        if (this.destroyed || this.peer !== peer) return;
        if (this.role === "mobile") {
          this.connectMobileToScreen();
        } else {
          this.p2pStatus = this.p2pConnected ? "connected" : "ready";
          this.emitConnectionState();
        }
      });

      if (this.role === "screen") {
        peer.on("connection", (conn) => {
          this.attachP2PConnection(conn);
        });
      }

      peer.on("disconnected", () => {
        if (!this.destroyed && this.peer === peer && !peer.destroyed) {
          try { peer.reconnect(); } catch (e) {}
        }
      });

      peer.on("error", (err) => {
        if (this.destroyed || this.peer !== peer) return;
        console.warn("P2P 信令提示:", err.type, err.message);

        if (this.role === "screen" && err.type === "unavailable-id") {
          // 頁面快速重整時舊 ID 尚未釋放，稍後重試
          this.scheduleP2PRetry(2500);
        } else if (this.role === "mobile" && err.type === "peer-unavailable") {
          this.p2pStatus = "waiting";
          this.emitConnectionState();
          this.scheduleMobileReconnect(3000);
        } else {
          this.p2pStatus = "error";
          this.emitConnectionState();
        }
      });
    } catch (err) {
      console.warn("P2P 模組初始化失敗 (將使用本機或 Firebase 通道):", err);
      this.p2pStatus = "error";
      this.emitConnectionState();
    }
  }

  connectMobileToScreen() {
    if (this.destroyed || !this.peer || this.peer.destroyed || this.role !== "mobile") return;
    if (this.p2pConnected) return;

    clearTimeout(this.p2pRetryTimer);
    const targetPeerId = `pt-screen-${this.screenId}`;

    try {
      const conn = this.peer.connect(targetPeerId, {
        reliable: true,
        serialization: "binary"
      });
      this.attachP2PConnection(conn);

      // 若 5 秒內尚未開啟連線，定時重試直到連上大屏
      this.p2pRetryTimer = setTimeout(() => {
        if (!this.destroyed && !this.p2pConnected) {
          try { conn.close(); } catch (e) {}
          this.connectMobileToScreen();
        }
      }, 5000);
    } catch (e) {
      this.scheduleMobileReconnect(3000);
    }
  }

  scheduleP2PRetry(delayMs) {
    clearTimeout(this.p2pRetryTimer);
    this.p2pRetryTimer = setTimeout(() => {
      if (!this.destroyed) {
        this.destroyP2P();
        this.initP2P();
      }
    }, delayMs);
  }

  scheduleMobileReconnect(delayMs) {
    clearTimeout(this.p2pRetryTimer);
    this.p2pRetryTimer = setTimeout(() => {
      if (!this.destroyed && !this.p2pConnected) {
        this.connectMobileToScreen();
      }
    }, delayMs);
  }

  attachP2PConnection(conn) {
    conn.on("open", () => {
      if (this.destroyed) {
        try { conn.close(); } catch (e) {}
        return;
      }
      clearTimeout(this.p2pRetryTimer);
      this.p2pConnections.add(conn);
      this.p2pConnected = true;
      this.p2pStatus = "connected";
      this.emitConnectionState();
      console.log(`✅ P2P 通道已建立 (${this.role} -> ${conn.peer})`);
    });

    conn.on("data", (msg) => {
      this.handleIncomingP2PMessage(msg);
    });

    const handleClose = () => {
      this.p2pConnections.delete(conn);
      this.p2pConnected = this.p2pConnections.size > 0;
      this.p2pStatus = this.p2pConnected ? "connected" : (this.role === "screen" ? "ready" : "waiting");
      if (!this.p2pConnected && this.incomingVideos.size > 0) {
        for (const [vidId, entry] of this.incomingVideos.entries()) {
          const percent = Math.min(99, Math.round((entry.received / Math.max(1, entry.totalChunks)) * 100));
          this.triggerCallbacks("videoReceive", {
            state: "aborted",
            percent,
            id: vidId,
            name: entry.name
          });
        }
        this.incomingVideos.clear();
      }
      this.emitConnectionState();
      if (this.role === "mobile" && !this.destroyed && !this.p2pConnected) {
        this.scheduleMobileReconnect(2500);
      }
    };

    conn.on("close", handleClose);
    conn.on("error", handleClose);
  }

  handleIncomingP2PMessage(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case "STATUS_UPDATE":
        this.triggerCallbacks("status", msg.data);
        break;
      case "DISPLAY_OPTS_UPDATE":
        this.triggerCallbacks("displayOpts", msg.data);
        break;
      case "PHYSICS_DATA_UPDATE":
        this.triggerCallbacks("physicsData", msg.data);
        break;
      case "DRAW_EVENT":
        this.triggerCallbacks("drawEvents", msg.data);
        break;
      case "VIDEO_START": {
        if (this.completedVideoIds.has(msg.id)) return;
        this.incomingVideos.set(msg.id, {
          name: msg.name || "video.mp4",
          mimeType: msg.mimeType || "video/mp4",
          size: msg.size || 0,
          totalChunks: msg.totalChunks || 1,
          chunks: new Array(msg.totalChunks || 1),
          received: 0,
          lastPercent: -1
        });
        this.triggerCallbacks("videoReceive", {
          state: "start",
          percent: 0,
          id: msg.id,
          name: msg.name,
          size: msg.size
        });
        break;
      }
      case "VIDEO_CHUNK": {
        const entry = this.incomingVideos.get(msg.id);
        if (!entry) return;
        let bytes;
        if (msg.buffer instanceof ArrayBuffer) {
          bytes = msg.buffer;
        } else if (ArrayBuffer.isView(msg.buffer)) {
          bytes = msg.buffer.buffer.slice(msg.buffer.byteOffset, msg.buffer.byteOffset + msg.buffer.byteLength);
        } else {
          bytes = new Uint8Array(msg.buffer);
        }
        entry.chunks[msg.index] = bytes;
        entry.received++;

        const percent = Math.min(99, Math.round((entry.received / entry.totalChunks) * 100));
        if (percent !== entry.lastPercent && (percent % 2 === 0 || entry.received === entry.totalChunks)) {
          entry.lastPercent = percent;
          this.triggerCallbacks("videoReceive", {
            state: "progress",
            percent,
            id: msg.id,
            name: entry.name
          });
        }
        break;
      }
      case "VIDEO_END": {
        const entry = this.incomingVideos.get(msg.id);
        if (!entry || this.completedVideoIds.has(msg.id)) return;
        this.incomingVideos.delete(msg.id);

        const expectedChunks = msg.totalChunks || entry.totalChunks;
        if (entry.received < expectedChunks) {
          console.warn(`⚠️ 影片分片不完整 (${entry.received}/${expectedChunks})，已取消組裝`);
          this.triggerCallbacks("videoReceive", {
            state: "error",
            percent: Math.round((entry.received / Math.max(1, expectedChunks)) * 100),
            id: msg.id,
            name: entry.name,
            received: entry.received,
            totalChunks: expectedChunks
          });
          break;
        }

        this.completedVideoIds.add(msg.id);
        const blob = new Blob(entry.chunks.filter(Boolean), { type: entry.mimeType });
        const url = URL.createObjectURL(blob);
        this.triggerCallbacks("videoReceive", {
          state: "complete",
          percent: 100,
          id: msg.id,
          name: entry.name,
          blob,
          url
        });
        break;
      }
    }
  }

  postToP2P(payload) {
    if (!this.p2pConnected) return false;
    let sent = false;
    for (const conn of this.p2pConnections) {
      if (conn.open) {
        try {
          conn.send(payload);
          sent = true;
        } catch (e) {
          console.warn("P2P 發送失敗:", e);
        }
      }
    }
    return sent;
  }

  emitConnectionState() {
    this.triggerCallbacks("connection", this.getConnectionSummary());
  }

  getConnectionSummary() {
    return {
      p2pConnected: this.p2pConnected,
      p2pStatus: this.p2pStatus,
      firebaseReady: this.isFirebaseReady,
      peerCount: this.p2pConnections.size
    };
  }

  // --- Firebase 雲端同步 ---

  loadFirebaseConfig() {
    try {
      const saved = localStorage.getItem("physics_tracker_firebase_config");
      const config = saved ? JSON.parse(saved) : DEFAULT_FIREBASE_CONFIG;
      if (config.apiKey && config.databaseURL) {
        this.initFirebase(config);
      }
    } catch (e) {
      console.warn("Firebase 本地設定載入失敗，將採用本機/P2P通道:", e);
    }
  }

  async initFirebase(config) {
    try {
      const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js");
      const { getDatabase, ref, onValue, set, push, update } = await import("https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js");

      this.firebaseApp = initializeApp(config);
      this.db = getDatabase(this.firebaseApp);
      this.fbRef = ref;
      this.fbOnValue = onValue;
      this.fbSet = set;
      this.fbPush = push;
      this.fbUpdate = update;
      this.isFirebaseReady = true;

      console.log("Firebase Realtime Database 連線已就緒！");
      this.listenToFirebase();
      this.emitConnectionState();
      return true;
    } catch (err) {
      console.warn("Firebase SDK 載入或連線失敗，保留 P2P / BroadcastChannel 運作:", err);
      this.isFirebaseReady = false;
      this.emitConnectionState();
      return false;
    }
  }

  listenToFirebase() {
    if (!this.isFirebaseReady || !this.db) return;

    const screenPath = `screens/${this.screenId}`;

    this.fbOnValue(this.fbRef(this.db, `${screenPath}/status`), (snapshot) => {
      const val = snapshot.val();
      if (val) this.triggerCallbacks("status", val);
    });

    this.fbOnValue(this.fbRef(this.db, `${screenPath}/displayOpts`), (snapshot) => {
      const val = snapshot.val();
      if (val) this.triggerCallbacks("displayOpts", val);
    });

    this.fbOnValue(this.fbRef(this.db, `${screenPath}/physicsData`), (snapshot) => {
      const val = snapshot.val();
      if (val) this.triggerCallbacks("physicsData", val);
    });

    this.fbOnValue(this.fbRef(this.db, `${screenPath}/drawEvents`), (snapshot) => {
      const val = snapshot.val();
      if (val) {
        const keys = Object.keys(val);
        const latest = val[keys[keys.length - 1]];
        if (latest) this.triggerCallbacks("drawEvents", latest);
      }
    });
  }

  triggerCallbacks(type, data) {
    (this.callbacks[type] || []).forEach(cb => {
      try { cb(data); } catch (e) { console.error("回呼處理異常:", e); }
    });
  }

  // --- 發送端方法 ---

  async updateStatus(status) {
    try {
      localStorage.setItem(`physics_status_${this.screenId}`, JSON.stringify(status));
    } catch (e) {}
    this.bc.postMessage({ type: "STATUS_UPDATE", data: status });
    this.postToP2P({ type: "STATUS_UPDATE", data: status });

    if (this.isFirebaseReady && this.db) {
      try {
        await this.fbUpdate(this.fbRef(this.db, `screens/${this.screenId}/status`), status);
      } catch (err) {
        console.error("Firebase updateStatus 錯誤:", err);
      }
    }
  }

  async updateDisplayOpts(opts) {
    try {
      localStorage.setItem(`physics_opts_${this.screenId}`, JSON.stringify(opts));
    } catch (e) {}
    this.bc.postMessage({ type: "DISPLAY_OPTS_UPDATE", data: opts });
    this.postToP2P({ type: "DISPLAY_OPTS_UPDATE", data: opts });

    if (this.isFirebaseReady && this.db) {
      try {
        await this.fbSet(this.fbRef(this.db, `screens/${this.screenId}/displayOpts`), opts);
      } catch (err) {
        console.error("Firebase updateDisplayOpts 錯誤:", err);
      }
    }
  }

  async sendPhysicsData(data) {
    try {
      localStorage.setItem(`physics_data_${this.screenId}`, JSON.stringify(data));
    } catch (e) {}
    this.bc.postMessage({ type: "PHYSICS_DATA_UPDATE", data: data });
    this.postToP2P({ type: "PHYSICS_DATA_UPDATE", data: data });

    if (this.isFirebaseReady && this.db) {
      try {
        await this.fbSet(this.fbRef(this.db, `screens/${this.screenId}/physicsData`), data);
      } catch (err) {
        console.error("Firebase sendPhysicsData 錯誤:", err);
      }
    }
  }

  async sendDrawEvent(drawEvent) {
    this.bc.postMessage({ type: "DRAW_EVENT", data: drawEvent });
    this.postToP2P({ type: "DRAW_EVENT", data: drawEvent });

    if (this.isFirebaseReady && this.db) {
      try {
        await this.fbPush(this.fbRef(this.db, `screens/${this.screenId}/drawEvents`), drawEvent);
      } catch (err) {
        console.error("Firebase sendDrawEvent 錯誤:", err);
      }
    }
  }

  /**
   * 傳送實際影片檔案 (支援同裝置 Blob 廣播與跨裝置 WebRTC 分片串流)
   * @param {File|Blob} fileOrBlob 影片檔案
   * @param {Function} onProgress 進度回呼 ({ percent, sentBytes, totalBytes })
   */
  async sendVideoFile(fileOrBlob, onProgress = () => {}) {
    if (!fileOrBlob) return { sentViaP2P: false, sentViaLocal: false };

    const transferId = `vid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.activeTransferId = transferId;
    const name = fileOrBlob.name || "mobile_video.mp4";
    const mimeType = fileOrBlob.type || "video/mp4";
    const size = fileOrBlob.size;

    // 1. 同機跨頁籤直接傳送 Blob
    let sentViaLocal = false;
    try {
      this.bc.postMessage({
        type: "VIDEO_BLOB",
        data: { id: transferId, name, mimeType, blob: fileOrBlob }
      });
      sentViaLocal = true;
    } catch (e) {
      console.warn("BroadcastChannel 影片傳送失敗:", e);
    }

    // 2. 跨裝置 WebRTC P2P 分片串流
    const openConns = [...this.p2pConnections].filter(c => c.open);
    if (openConns.length === 0) {
      return { sentViaP2P: false, sentViaLocal, transferId };
    }

    const totalChunks = Math.max(1, Math.ceil(size / CHUNK_SIZE));
    let lastPercent = 0;
    for (const conn of openConns) {
      try {
        conn.send({ type: "VIDEO_START", id: transferId, name, mimeType, size, totalChunks });
      } catch (e) {
        console.warn("VIDEO_START 發送失敗:", e);
      }
    }

    const waitForChannelBuffer = async (conn, drainToZero = false) => {
      const dc = conn.dataChannel;
      const limit = drainToZero ? 0 : MAX_BUFFERED_AMOUNT;
      const startWait = Date.now();
      while (conn.open && ((conn.bufferSize > 0) || (dc && dc.readyState === "open" && dc.bufferedAmount > limit))) {
        if (this.destroyed || this.activeTransferId !== transferId) return false;
        if (Date.now() - startWait > 15000) return false;
        await new Promise(r => setTimeout(r, 20));
      }
      return conn.open;
    };

    let cachedBlockStart = -1;
    let cachedBlockBytes = null;

    for (let index = 0; index < totalChunks; index++) {
      if (this.destroyed || this.activeTransferId !== transferId) {
        return {
          sentViaP2P: false,
          aborted: true,
          superseded: !this.destroyed && this.activeTransferId !== transferId,
          lastPercent,
          sentViaLocal,
          transferId
        };
      }

      const activeConns = openConns.filter(c => c.open);
      if (activeConns.length === 0) {
        return { sentViaP2P: false, aborted: true, disconnected: true, lastPercent, sentViaLocal, transferId };
      }

      const start = index * CHUNK_SIZE;
      const end = Math.min(size, start + CHUNK_SIZE);
      if (!cachedBlockBytes || start < cachedBlockStart || end > cachedBlockStart + cachedBlockBytes.byteLength) {
        cachedBlockStart = start;
        const blockEnd = Math.min(size, start + READ_BLOCK_SIZE);
        const blockBuf = await fileOrBlob.slice(start, blockEnd).arrayBuffer();
        cachedBlockBytes = new Uint8Array(blockBuf);
      }
      const offsetInBlock = start - cachedBlockStart;
      const buffer = cachedBlockBytes.slice(offsetInBlock, offsetInBlock + (end - start));

      for (const conn of activeConns) {
        const ok = await waitForChannelBuffer(conn, false);
        if (!ok) {
          if (this.destroyed || this.activeTransferId !== transferId) {
            return {
              sentViaP2P: false,
              aborted: true,
              superseded: !this.destroyed && this.activeTransferId !== transferId,
              lastPercent,
              sentViaLocal,
              transferId
            };
          }
          continue;
        }
        try {
          conn.send({ type: "VIDEO_CHUNK", id: transferId, index, buffer });
        } catch (e) {
          console.warn("VIDEO_CHUNK 發送異常:", e);
          return { sentViaP2P: false, aborted: true, error: e.message, lastPercent, sentViaLocal, transferId };
        }
      }

      // 每 4 片讓出主執行緒，確保手機進度條流暢繪製
      if (index % 4 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }

      lastPercent = Math.min(100, Math.round(((index + 1) / totalChunks) * 100));
      onProgress({ percent: lastPercent, sentBytes: end, totalBytes: size });
    }

    // 確保緩衝區全數清空後再送出 VIDEO_END，避免結尾封包遺失或超前
    let anySentEnd = false;
    for (const conn of openConns) {
      if (conn.open) {
        await waitForChannelBuffer(conn, true);
        if (conn.open) {
          try {
            conn.send({ type: "VIDEO_END", id: transferId, totalChunks });
            anySentEnd = true;
          } catch (e) {}
        }
      }
    }

    return { sentViaP2P: anySentEnd, lastPercent: anySentEnd ? 100 : lastPercent, sentViaLocal, transferId };
  }

  // --- 監聽端註冊 ---

  onStatusChange(cb) {
    this.callbacks.status.push(cb);
  }

  onDisplayOptsChange(cb) {
    this.callbacks.displayOpts.push(cb);
  }

  onPhysicsDataChange(cb) {
    this.callbacks.physicsData.push(cb);
  }

  onDrawEvent(cb) {
    this.callbacks.drawEvents.push(cb);
  }

  onVideoReceive(cb) {
    this.callbacks.videoReceive.push(cb);
  }

  onConnectionChange(cb) {
    this.callbacks.connection.push(cb);
  }

  destroyP2P() {
    clearTimeout(this.p2pRetryTimer);
    for (const conn of this.p2pConnections) {
      try { conn.close(); } catch (e) {}
    }
    this.p2pConnections.clear();
    this.p2pConnected = false;
    if (this.peer) {
      try { this.peer.destroy(); } catch (e) {}
      this.peer = null;
    }
  }

  destroy() {
    this.destroyed = true;
    this.activeTransferId = null;
    if (this.bc) {
      try { this.bc.close(); } catch (e) {}
    }
    this.destroyP2P();
  }
}
