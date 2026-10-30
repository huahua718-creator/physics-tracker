# Physics Tracker (預錄慢動作影片分析與大屏投影系統)

前後端分離、資料驅動的物理運動分析系統。徹底解決傳統手機端即時串流影像造成掉幀、過熱降頻與解析度低落的瓶頸。

---

## 🌟 核心架構與設計理念

1. **離線逐幀解析 (Non-realtime Step Frame Extraction)**：
   - 擺脫 `requestAnimationFrame` 即時運算限制，以非同步步進器 `video.currentTime += dt` 穩定解析每一影格。
   - 支援 60 / 120 / 240 FPS 高幀率慢動作影片。
2. **物理數值引擎 (Savitzky-Golay 濾波與中心差分求導)**：
   - 採用 **5 點二次多項式 Savitzky-Golay 濾波** 平滑化像素座標，保留拋體真實曲率，消除離散像素階梯雜訊。
   - 二階高精度中心差分法計算速度向量 $\vec{v}(t)$ 與加速度向量 $\vec{a}(t)$。
3. **資料驅動解耦傳輸 (Data-Driven)**：
   - 手機僅傳輸輕量化 JSON 物理數據，大屏原生硬體解碼播放原始高畫質影片。
   - 大屏依據播放時間 $t$ 即時內插物理影格，疊加運動殘影 (Strobe)、速度箭頭 (綠) 與加速度箭頭 (紅)。
4. **雙模同步支援**：
   - 本機測試自動啟用 `BroadcastChannel` 零設定即時同步。
   - 遠端教學支援 Firebase Realtime Database 跨網域 (4G/5G 手機遙控投影大屏)。
5. **課堂互動電子白板 (Annotation Layer)**：
   - 解析度無關 (0.0 ~ 1.0 標準化百分比座標) 雙向筆跡手寫同步。

---

## 📂 專案檔案結構

```
physics-tracker/
├── index.html              # 大屏接收端主頁 (高畫質底圖、HUD、向量殘影、白板)
├── mobile.html             # 手機控制器主頁 (影片取色、尺標校準、逐幀解析、播放遙控)
├── server.js               # 零依賴極速本地 HTTP 伺服器 (自動回報區域網路 IP)
├── package.json            # 專案資訊與啟動指令 (npm start)
├── css/
│   ├── screen.css          # 大屏滿版投影與儀表板樣式
│   └── mobile.css          # 手機觸控操作面板樣式
└── js/
    ├── firebase-config.js  # Firebase Realtime Database / BroadcastChannel 雙模同步
    ├── physics-engine.js   # Savitzky-Golay 平滑、速度/加速度中心差分與時間內插
    ├── video-tracker.js    # 離線逐幀讀取、色彩空間距離、質心辨識、示範影片生成
    ├── vector-drawer.js    # Canvas 向量箭頭 (v, a) 與運動殘影 (Strobe) 繪製
    └── annotation.js       # 課堂手寫筆劃同步模組
```

---

## 🚀 快速啟動指引

### 1. 啟動伺服器
在專案目錄下執行：
```bash
node server.js
# 或使用 npm
npm start
```
伺服器啟動後將印出：
- **大屏接收端**：`http://localhost:3000/index.html`
- **手機端控制器**：`http://localhost:3000/mobile.html`
- **區域網路手機配對**：`http://[你的區域IP]:3000/mobile.html?room=[PIN]`

### 2. 操作流程
1. 在投影電腦或大螢幕開啟 `index.html`，螢幕將顯示 6 碼配對 PIN 與 QR Code。
2. 手機開啟 `mobile.html`（或掃描 QR Code 自動填入 PIN）。
3. 點選 **「🧪 示範拋體影片」** 或選取自己的慢動作影片。
4. 點擊球體進行目標色彩鎖定，設定尺標長度（預設 1.0 m）。
5. 點擊 **「🚀 開始逐幀分析軌跡」**，系統將以離線步進器平滑提取完整拋體數據。
6. 點擊 **「📡 同步物理數據至大屏」**，切換至 **「2. 播放遙控」** 即可遙控大屏播放、殘影切換與手寫白板標註！
