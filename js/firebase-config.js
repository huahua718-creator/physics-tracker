/**
 * firebase-config.js
 * 雙模同步管理器：支援 Firebase Realtime Database 與本機 BroadcastChannel 雙向切換
 * 確保在無需事先配置 Firebase Key 的情況下仍可立即於本機測試，
 * 同時填入 Firebase 憑證後即可實現全球跨網域手機與大屏即時同步。
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

export class SyncManager {
  constructor(screenId, role = "screen") {
    this.screenId = screenId;
    this.role = role; // "screen" | "mobile"
    this.isFirebaseReady = false;
    this.firebaseApp = null;
    this.db = null;

    // 回呼註冊器
    this.callbacks = {
      status: [],
      displayOpts: [],
      physicsData: [],
      drawEvents: []
    };

    // 本地跨頁籤同步通道 (作為本機與離線 fallback)
    this.channelName = `physics_tracker_${screenId}`;
    this.bc = new BroadcastChannel(this.channelName);
    this.setupBroadcastChannel();

    // 嘗試讀取本地儲存的 Firebase 設定
    this.loadFirebaseConfig();
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
      }
    };

    // 啟動時讀取快照以防跨頁籤開啟時序差
    setTimeout(() => {
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

  loadFirebaseConfig() {
    try {
      const saved = localStorage.getItem("physics_tracker_firebase_config");
      const config = saved ? JSON.parse(saved) : DEFAULT_FIREBASE_CONFIG;
      if (config.apiKey && config.databaseURL) {
        this.initFirebase(config);
      }
    } catch (e) {
      console.warn("Firebase 本地設定載入失敗，將採用本機模擬通道:", e);
    }
  }

  async initFirebase(config) {
    try {
      // 動態載入 Firebase Modular SDK (CDN)
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
      return true;
    } catch (err) {
      console.warn("Firebase SDK 載入或連線失敗，保留 BroadcastChannel 運作:", err);
      this.isFirebaseReady = false;
      return false;
    }
  }

  listenToFirebase() {
    if (!this.isFirebaseReady || !this.db) return;

    const screenPath = `screens/${this.screenId}`;

    // 監聽狀態
    this.fbOnValue(this.fbRef(this.db, `${screenPath}/status`), (snapshot) => {
      const val = snapshot.val();
      if (val) this.triggerCallbacks("status", val);
    });

    // 監聽顯示設定
    this.fbOnValue(this.fbRef(this.db, `${screenPath}/displayOpts`), (snapshot) => {
      const val = snapshot.val();
      if (val) this.triggerCallbacks("displayOpts", val);
    });

    // 監聽物理數據
    this.fbOnValue(this.fbRef(this.db, `${screenPath}/physicsData`), (snapshot) => {
      const val = snapshot.val();
      if (val) this.triggerCallbacks("physicsData", val);
    });

    // 監聽白板繪圖事件
    this.fbOnValue(this.fbRef(this.db, `${screenPath}/drawEvents`), (snapshot) => {
      const val = snapshot.val();
      if (val) {
        // 取最新一筆或遍歷
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
    // 1. 本地通道廣播與 localStorage 快照
    try {
      localStorage.setItem(`physics_status_${this.screenId}`, JSON.stringify(status));
    } catch (e) {}
    this.bc.postMessage({ type: "STATUS_UPDATE", data: status });

    // 2. Firebase 雲端同步
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

    if (this.isFirebaseReady && this.db) {
      try {
        await this.fbPush(this.fbRef(this.db, `screens/${this.screenId}/drawEvents`), drawEvent);
      } catch (err) {
        console.error("Firebase sendDrawEvent 錯誤:", err);
      }
    }
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

  destroy() {
    if (this.bc) this.bc.close();
  }
}
