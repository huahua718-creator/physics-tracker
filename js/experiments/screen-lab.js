/**
 * screen-lab.js
 * 大屏端 5 大即時感測器實驗視覺化與多機協作工作區
 * 支援：ACCEL_3D / INCLINE_GYRO / AUDIO_FFT / ACOUSTIC_TIMER / CAM_PHOTOGATE
 */

import { LAB_MODES, NODE_COLORS, exportCsvRows, freqToNoteName } from "./protocol.js";

export class ScreenSensorLab {
  constructor(containerEl, syncManager) {
    this.container = containerEl;
    this.sync = syncManager;
    this.activeMode = "VIDEO_TRACKER";
    this.rafId = null;

    // 多機即時緩衝狀態 nodeId -> { id, color, samples: [], latest: null }
    this.nodes = new Map();

    // 各實驗狀態資料
    this.accelState = {
      massKg: 60,
      recordingIntegral: false,
      integralSamples: [],
      lastDeltaV: null,
      axisKey: "az"
    };
    this.inclineState = {
      massKg: 1.0,
      pendulumLenM: 1.0,
      slipLocked: false,
      slipThetaDeg: null,
      slipMu: null,
      prevOmegaSign: 0,
      zeroCrossTimes: [],
      pendulumPeriod: null,
      pendulumG: null,
      history: []
    };
    this.audioState = {
      viewMode: "spectrum", // "spectrum" | "waterfall"
      beatZoom: false,
      waterfallRows: [],
      history: []
    };
    this.timerState = {
      heightM: 1.5,
      soundDistM: 10.0,
      subMode: "freefall", // "freefall" | "sound"
      armed: true,
      t1: null,
      t2: null,
      dualT1A: null,
      dualT2A: null,
      dualT1B: null,
      dualT2B: null,
      trials: [],
      vuLevel: 0,
      threshold: 0.25
    };
    this.gateState = {
      subMode: "linear", // "linear" | "dual" | "rpm"
      flagCm: 2.0,
      bladesPerRev: 1,
      threshold: 100,
      lastGateA: null,
      lastPassTime: null,
      passes: []
    };
  }

  getNodeBucket(nodeId) {
    const id = nodeId || "node_01";
    if (!this.nodes.has(id)) {
      const idx = this.nodes.size;
      const peerMatch = this.sync.getConnectedNodes().find(n => n.nodeId === id);
      this.nodes.set(id, {
        id,
        color: peerMatch?.color || NODE_COLORS[idx % NODE_COLORS.length],
        samples: [],
        latest: null
      });
    }
    return this.nodes.get(id);
  }

  setMode(mode) {
    this.activeMode = mode;
    if (mode === "VIDEO_TRACKER") {
      this.container.classList.add("hidden");
      this.stopLoop();
      return;
    }

    this.container.classList.remove("hidden");
    this.buildModeUI(mode);
    this.startLoop();
  }

  startLoop() {
    if (this.rafId) return;
    const tick = () => {
      if (this.activeMode === "VIDEO_TRACKER") {
        this.rafId = null;
        return;
      }
      this.renderActiveCanvas();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stopLoop() {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * 接收來自 WebRTC / BroadcastChannel 的高頻 JSON 感測封包
   */
  handleSensorPacket(pkt) {
    if (!pkt || !pkt.mode || !pkt.data) return;
    const bucket = this.getNodeBucket(pkt.id);
    const ts = Number(pkt.t) || performance.now();
    const record = { t: ts, recvAt: performance.now(), ...pkt.data };
    bucket.latest = record;
    bucket.samples.push(record);
    if (bucket.samples.length > 600) bucket.samples.shift();

    if (pkt.mode === "ACCEL_3D" && this.accelState.recordingIntegral) {
      this.accelState.integralSamples.push({ t: ts / 1000, a: pkt.data.laz ?? 0, linMag: Math.hypot(pkt.data.lax || 0, pkt.data.lay || 0, pkt.data.laz || 0) });
    } else if (pkt.mode === "INCLINE_GYRO") {
      this.processInclineEvents(pkt.id, record);
    } else if (pkt.mode === "AUDIO_FFT") {
      this.audioState.history.push({ t: ts, id: pkt.id, peakFreq: pkt.data.peakFreq, db: pkt.data.db, rms: pkt.data.rms });
      if (this.audioState.history.length > 500) this.audioState.history.shift();
      if (Array.isArray(pkt.data.spectrum)) {
        this.audioState.waterfallRows.push(pkt.data.spectrum);
        if (this.audioState.waterfallRows.length > 90) this.audioState.waterfallRows.shift();
      }
    } else if (pkt.mode === "ACOUSTIC_TIMER") {
      this.processAcousticTimerEvent(pkt.id, pkt.data);
    } else if (pkt.mode === "CAM_PHOTOGATE") {
      this.processPhotogateEvent(pkt.id, pkt.data, ts);
    }
  }

  // --- 共用畫布繪製與計算工具 ---

  syncCanvasSize(canvas) {
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(100, Math.floor(rect.width * dpr));
    const h = Math.max(80, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return { ctx: canvas.getContext("2d"), w, h, dpr };
  }

  /**
   * 共用 10 秒滾動多機折線圖繪製器 (供 ACCEL_3D 與 CAM_PHOTOGATE 複用)
   */
  drawRollingChart(canvas, { valueKey, yMin, yMax, unit, title, thresholdLine = null }) {
    const meta = this.syncCanvasSize(canvas);
    if (!meta) return;
    const { ctx, w, h, dpr } = meta;
    ctx.clearRect(0, 0, w, h);

    const pad = { l: 56 * dpr, r: 16 * dpr, t: 30 * dpr, b: 26 * dpr };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;
    const now = performance.now();
    const winMs = 10000;

    // 網格與刻度
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.fillStyle = "#94a3b8";
    ctx.font = `${11 * dpr}px monospace`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    for (let i = 0; i <= 4; i++) {
      const val = yMin + (i / 4) * (yMax - yMin);
      const y = pad.t + ph - (i / 4) * ph;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + pw, y);
      ctx.stroke();
      ctx.fillText(`${val.toFixed(1)}`, pad.l - 6 * dpr, y);
    }

    ctx.textAlign = "left";
    ctx.fillStyle = "#f8fafc";
    ctx.font = `bold ${12 * dpr}px sans-serif`;
    ctx.fillText(`${title} (${unit})`, pad.l, pad.t - 14 * dpr);

    // 閾值線
    if (thresholdLine !== null && thresholdLine >= yMin && thresholdLine <= yMax) {
      const ty = pad.t + ph - ((thresholdLine - yMin) / (yMax - yMin)) * ph;
      ctx.strokeStyle = "#facc15";
      ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([5 * dpr, 4 * dpr]);
      ctx.beginPath();
      ctx.moveTo(pad.l, ty);
      ctx.lineTo(pad.l + pw, ty);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 裁切並繪製每台連線手機曲線
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, pad.t, pw, ph);
    ctx.clip();

    for (const bucket of this.nodes.values()) {
      const recent = bucket.samples.filter(s => now - s.recvAt <= winMs && s[valueKey] !== undefined);
      if (recent.length < 2) continue;

      ctx.strokeStyle = bucket.color;
      ctx.lineWidth = 2.4 * dpr;
      ctx.beginPath();
      recent.forEach((s, idx) => {
        const x = pad.l + (1 - (now - s.recvAt) / winMs) * pw;
        const clamped = Math.max(yMin, Math.min(yMax, s[valueKey]));
        const y = pad.t + ph - ((clamped - yMin) / (yMax - yMin)) * ph;
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
    ctx.restore();

    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.strokeRect(pad.l, pad.t, pw, ph);
    ctx.restore();
  }

  // --- UI 建構 (5 大實驗面板) ---

  buildModeUI(mode) {
    const info = LAB_MODES[mode];
    const nodeChips = this.renderNodeBadgesHtml();

    if (mode === "ACCEL_3D") {
      this.container.innerHTML = `
        <div class="lab-shell">
          <div class="lab-header">
            <div>
              <h2>${info.icon} 模組一：${info.title}</h2>
              <span class="lab-sub">${info.unit}</span>
            </div>
            <div class="lab-actions">
              <div class="lab-node-badges" id="labNodeBadges">${nodeChips}</div>
              <button class="btn-icon" id="labCmdZero">🧭 手機歸零</button>
              <button class="btn-export" id="labBtnExportCsv">📥 匯出 CSV</button>
            </div>
          </div>

          <div class="lab-grid-2">
            <div class="lab-card" style="display:flex;flex-direction:column;gap:12px;">
              <div class="lab-card-title">📱 3D 空間姿態與合加速度向量</div>
              <canvas id="accel3dCanvas" style="width:100%;height:260px;background:rgba(0,0,0,0.3);border-radius:10px;"></canvas>

              <div class="lab-scale-box">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                  <span style="font-weight:bold;color:#38bdf8;">⚖️ 電梯模擬體重計</span>
                  <label style="font-size:0.82rem;color:#cbd5e1;">真實質量 m:
                    <input type="number" id="accelMassInput" value="${this.accelState.massKg}" min="1" step="1" class="lab-input-sm"> kg
                  </label>
                </div>
                <div class="lab-big-readout" id="accelWeightReadout">--.- kgf (--- N)</div>
                <div class="lab-status-tag" id="accelStateBadge">等待手機啟動 ACCEL_3D...</div>
              </div>
            </div>

            <div class="lab-card" style="display:flex;flex-direction:column;gap:10px;">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span class="lab-card-title">📈 多機滾動 a-t 折線圖 (10s 視窗)</span>
                <select id="accelAxisSelect" class="chart-select-filter">
                  <option value="az">含重力 az (電梯視重)</option>
                  <option value="laz">線性 laz (純運動)</option>
                  <option value="lax">線性 lax</option>
                  <option value="lay">線性 lay</option>
                </select>
              </div>
              <canvas id="accelChartCanvas" style="width:100%;height:290px;background:rgba(0,0,0,0.3);border-radius:10px;"></canvas>

              <div class="lab-scale-box" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
                <div>
                  <div style="font-weight:bold;color:#10b981;">∫ 運動學梯形積分器 (Δv = ∫a dt)</div>
                  <div style="font-size:0.84rem;color:#cbd5e1;" id="accelIntegralResult">點擊開始錄製衝突/加速區間</div>
                </div>
                <button class="btn-icon" id="btnToggleIntegral" style="background:rgba(16,185,129,0.2);border-color:#10b981;font-weight:bold;">⏺ 開始錄製區間</button>
              </div>
            </div>
          </div>
        </div>`;

      document.getElementById("accelMassInput").oninput = (e) => {
        this.accelState.massKg = Math.max(0.1, Number(e.target.value) || 60);
      };
      document.getElementById("accelAxisSelect").onchange = (e) => {
        this.accelState.axisKey = e.target.value;
      };
      document.getElementById("btnToggleIntegral").onclick = (e) => {
        const st = this.accelState;
        if (!st.recordingIntegral) {
          st.recordingIntegral = true;
          st.integralSamples = [];
          e.target.textContent = "⏹ 停止並計算 Δv";
          e.target.style.background = "rgba(239,68,68,0.25)";
          document.getElementById("accelIntegralResult").textContent = "⏳ 錄製運動區間中...";
        } else {
          st.recordingIntegral = false;
          e.target.textContent = "⏺ 開始錄製區間";
          e.target.style.background = "rgba(16,185,129,0.2)";
          const dv = this.computeTrapezoidalDeltaV(st.integralSamples);
          st.lastDeltaV = dv;
          document.getElementById("accelIntegralResult").textContent = dv !== null
            ? `積分樣本 ${st.integralSamples.length} 筆 ⇒ Δv = ${dv.dv.toFixed(3)} m/s (時間 Δt=${dv.dt.toFixed(2)}s)`
            : "樣本不足（請先在手機端啟動感測器）";
        }
      };
      this.bindCommonLabButtons(() => this.exportAccelCsv());
    } else if (mode === "INCLINE_GYRO") {
      this.container.innerHTML = `
        <div class="lab-shell">
          <div class="lab-header">
            <div>
              <h2>${info.icon} 模組二：${info.title}</h2>
              <span class="lab-sub">${info.unit}</span>
            </div>
            <div class="lab-actions">
              <div class="lab-node-badges" id="labNodeBadges">${nodeChips}</div>
              <button class="btn-icon" id="labCmdZero">📐 桌面歸零 (0°)</button>
              <button class="btn-export" id="labBtnExportCsv">📥 匯出 CSV</button>
            </div>
          </div>

          <div class="lab-grid-2">
            <div class="lab-card" style="display:flex;flex-direction:column;gap:10px;">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span class="lab-card-title">📐 動態斜面力分解圖 (mg, mg sinθ, N = mg cosθ)</span>
                <label style="font-size:0.8rem;color:#cbd5e1;">物體質量:
                  <input type="number" id="inclineMassInput" value="${this.inclineState.massKg}" min="0.1" step="0.1" class="lab-input-sm"> kg
                </label>
              </div>
              <canvas id="inclineCanvas" style="width:100%;height:340px;background:rgba(0,0,0,0.3);border-radius:10px;"></canvas>
            </div>

            <div class="lab-card" style="display:flex;flex-direction:column;gap:14px;">
              <div class="lab-scale-box">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                  <span style="font-weight:bold;color:#f59e0b;">🧊 最大靜摩擦力自動捕捉 (|a| &gt; 0.3 m/s²)</span>
                  <button class="btn-icon" id="btnResetFriction" style="padding:4px 10px;font-size:0.78rem;">↺ 重新偵測</button>
                </div>
                <div class="lab-big-readout" id="frictionReadout" style="color:#fcd34d;">待測 (θ = 0.0°)</div>
                <div style="font-size:0.84rem;color:#94a3b8;" id="frictionHint">將手機放置斜面上慢慢抬升，滑動瞬間自動鎖定 μs = tanθs</div>
              </div>

              <div class="lab-scale-box">
                <div style="display:flex;justify-content:space-between;align-items:center;">
                  <span style="font-weight:bold;color:#38bdf8;">🕰️ 單擺週期自動計時器 (過零點偵測)</span>
                  <label style="font-size:0.8rem;color:#cbd5e1;">擺長 L:
                    <input type="number" id="pendulumLenInput" value="${this.inclineState.pendulumLenM}" min="0.1" step="0.1" class="lab-input-sm"> m
                  </label>
                </div>
                <div class="lab-big-readout" id="pendulumReadout">T = --.-- s | g = --.-- m/s²</div>
                <div style="font-size:0.82rem;color:#94a3b8;" id="pendulumHint">手機綁擺繩擺動時，自動偵測角速度 ω 過零瞬間換算週期 T</div>
              </div>
            </div>
          </div>
        </div>`;

      document.getElementById("inclineMassInput").oninput = (e) => {
        this.inclineState.massKg = Math.max(0.05, Number(e.target.value) || 1.0);
      };
      document.getElementById("pendulumLenInput").oninput = (e) => {
        this.inclineState.pendulumLenM = Math.max(0.05, Number(e.target.value) || 1.0);
      };
      document.getElementById("btnResetFriction").onclick = () => {
        this.inclineState.slipLocked = false;
        this.inclineState.slipThetaDeg = null;
        this.inclineState.slipMu = null;
        document.getElementById("frictionHint").textContent = "已重設！請重新緩慢抬高斜面...";
      };
      this.bindCommonLabButtons(() => this.exportInclineCsv());
    } else if (mode === "AUDIO_FFT") {
      this.container.innerHTML = `
        <div class="lab-shell">
          <div class="lab-header">
            <div>
              <h2>${info.icon} 模組三：${info.title}</h2>
              <span class="lab-sub">${info.unit}</span>
            </div>
            <div class="lab-actions">
              <div class="lab-node-badges" id="labNodeBadges">${nodeChips}</div>
              <button class="btn-icon" id="btnAudioViewToggle">🌊 切換瀑布圖</button>
              <button class="btn-icon" id="btnAudioBeatZoom">🔍 拍頻放大 (350~550Hz)</button>
              <button class="btn-export" id="labBtnExportCsv">📥 匯出 CSV</button>
            </div>
          </div>

          <div class="lab-card" style="display:flex;justify-content:space-between;align-items:center;padding:14px 20px;margin-bottom:12px;">
            <div>
              <div style="font-size:0.8rem;color:#94a3b8;">偵測主頻率 (0.1 Hz 拋物線內插)</div>
              <div style="font-size:2.4rem;font-weight:800;font-family:monospace;color:#8AC926;" id="audioPeakFreqText">---.- Hz</div>
            </div>
            <div style="text-align:center;">
              <div style="font-size:0.8rem;color:#94a3b8;">十二平均律音名</div>
              <div style="font-size:2.2rem;font-weight:800;color:#38bdf8;" id="audioNoteText">--</div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:0.8rem;color:#94a3b8;">響度 / 相對分貝</div>
              <div style="font-size:1.5rem;font-weight:700;font-family:monospace;color:#FFCA3A;" id="audioDbText">--.- dB</div>
            </div>
          </div>

          <div class="lab-card">
            <canvas id="audioFftCanvas" style="width:100%;height:350px;background:rgba(0,0,0,0.35);border-radius:10px;"></canvas>
          </div>
        </div>`;

      document.getElementById("btnAudioViewToggle").onclick = (e) => {
        this.audioState.viewMode = this.audioState.viewMode === "spectrum" ? "waterfall" : "spectrum";
        e.target.textContent = this.audioState.viewMode === "spectrum" ? "🌊 切換瀑布圖" : "📊 切換即時頻譜";
      };
      document.getElementById("btnAudioBeatZoom").onclick = (e) => {
        this.audioState.beatZoom = !this.audioState.beatZoom;
        e.target.classList.toggle("active", this.audioState.beatZoom);
      };
      this.bindCommonLabButtons(() => this.exportAudioCsv());
    } else if (mode === "ACOUSTIC_TIMER") {
      this.container.innerHTML = `
        <div class="lab-shell">
          <div class="lab-header">
            <div>
              <h2>${info.icon} 模組四：${info.title}</h2>
              <span class="lab-sub">${info.unit}</span>
            </div>
            <div class="lab-actions">
              <div class="lab-node-badges" id="labNodeBadges">${nodeChips}</div>
              <button class="btn-icon" id="btnTimerReset" style="background:rgba(56,189,248,0.2);border-color:#38bdf8;">🎯 重新待命</button>
              <button class="btn-export" id="labBtnExportCsv">📥 匯出 CSV</button>
            </div>
          </div>

          <div class="lab-grid-2">
            <div class="lab-card" style="display:flex;flex-direction:column;gap:14px;">
              <div style="display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;">
                <label style="font-size:0.9rem;color:#cbd5e1;">下落高度 h:
                  <input type="number" id="timerHeightInput" value="${this.timerState.heightM}" min="0.1" step="0.05" class="lab-input-sm"> m
                </label>
                <label style="font-size:0.85rem;color:#cbd5e1;">手機收音閾值:
                  <input type="range" id="timerThreshRange" min="0.05" max="0.8" step="0.05" value="${this.timerState.threshold}" style="vertical-align:middle;">
                  <span id="timerThreshLabel">${Math.round(this.timerState.threshold * 100)}%</span>
                </label>
              </div>

              <div class="lab-scale-box" style="text-align:center;padding:22px;">
                <div style="font-size:0.9rem;color:#94a3b8;" id="timerStepText">🟢 待命：請拍手／釋放鋼珠（第 1 聲啟動計時）</div>
                <div class="lab-big-readout" id="timerDeltaReadout" style="font-size:2.6rem;margin:10px 0;">Δt = -.---- s</div>
                <div style="font-size:1.4rem;font-weight:bold;color:#10b981;" id="timerGReadout">實驗 g = --.-- m/s² (誤差 --%)</div>
                <div style="margin-top:12px;height:10px;background:rgba(255,255,255,0.1);border-radius:5px;overflow:hidden;position:relative;">
                  <div id="timerVuBar" style="height:100%;width:0%;background:#38bdf8;transition:width 0.06s;"></div>
                </div>
                <div style="font-size:0.75rem;color:#64748b;margin-top:6px;">內建 150 ms 防回音盲區 | 單機 AudioContext 解析度 0.02 ms</div>
              </div>
            </div>

            <div class="lab-card" style="display:flex;flex-direction:column;gap:8px;">
              <div class="lab-card-title">📋 自由落體實驗紀錄表 (g = 2h / Δt²)</div>
              <div style="flex:1;max-height:330px;overflow:auto;">
                <table class="analysis-table">
                  <thead><tr><th>#</th><th>h (m)</th><th>Δt (s)</th><th>g (m/s²)</th><th>誤差</th></tr></thead>
                  <tbody id="timerTrialsBody">${this.renderTimerTrialsHtml()}</tbody>
                </table>
              </div>
            </div>
          </div>
        </div>`;

      document.getElementById("timerHeightInput").oninput = (e) => {
        this.timerState.heightM = Math.max(0.05, Number(e.target.value) || 1.5);
      };
      document.getElementById("timerThreshRange").oninput = (e) => {
        const val = Number(e.target.value);
        this.timerState.threshold = val;
        document.getElementById("timerThreshLabel").textContent = `${Math.round(val * 100)}%`;
        this.sync.broadcastCommand({ cmd: "SET_ACOUSTIC_THRESHOLD", threshold: val });
      };
      document.getElementById("btnTimerReset").onclick = () => {
        this.timerState.t1 = null;
        this.timerState.t2 = null;
        this.timerState.armed = true;
        document.getElementById("timerStepText").textContent = "🟢 待命：請拍手／釋放鋼珠（第 1 聲啟動計時）";
        document.getElementById("timerDeltaReadout").textContent = "Δt = -.---- s";
        document.getElementById("timerGReadout").textContent = "實驗 g = --.-- m/s² (誤差 --%)";
      };
      this.bindCommonLabButtons(() => this.exportTimerCsv());
    } else if (mode === "CAM_PHOTOGATE") {
      this.container.innerHTML = `
        <div class="lab-shell">
          <div class="lab-header">
            <div>
              <h2>${info.icon} 模組五：${info.title}</h2>
              <span class="lab-sub">${info.unit}</span>
            </div>
            <div class="lab-actions">
              <div class="lab-node-badges" id="labNodeBadges">${nodeChips}</div>
              <button class="btn-icon" id="btnCalibrateGate" style="background:rgba(250,204,21,0.2);border-color:#facc15;">🔆 自動校準環境光</button>
              <button class="btn-icon" id="btnClearGateTable">🧹 清除列表</button>
              <button class="btn-export" id="labBtnExportCsv">📥 匯出 CSV</button>
            </div>
          </div>

          <div class="lab-grid-2">
            <div class="lab-card" style="display:flex;flex-direction:column;gap:10px;">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
                <select id="gateSubModeSelect" class="chart-select-filter">
                  <option value="linear" ${this.gateState.subMode === "linear" ? "selected" : ""}>直線測速 (v = d / Δt)</option>
                  <option value="dual" ${this.gateState.subMode === "dual" ? "selected" : ""}>雙光電閘加速度 (node_01 → node_02)</option>
                  <option value="rpm" ${this.gateState.subMode === "rpm" ? "selected" : ""}>轉速計 (RPM / 週期 T)</option>
                </select>
                <label style="font-size:0.82rem;color:#cbd5e1;">遮光片寬 d:
                  <input type="number" id="gateFlagCmInput" value="${this.gateState.flagCm}" min="0.1" step="0.1" class="lab-input-sm"> cm
                </label>
              </div>
              <canvas id="gateFluxCanvas" style="width:100%;height:300px;background:rgba(0,0,0,0.3);border-radius:10px;"></canvas>
              <div style="font-size:0.85rem;color:#cbd5e1;" id="gateLiveStatus">目前遮光閾值：${this.gateState.threshold} / 255</div>
            </div>

            <div class="lab-card" style="display:flex;flex-direction:column;gap:8px;">
              <div class="lab-card-title">📋 光電閘通過紀錄表</div>
              <div style="flex:1;max-height:360px;overflow:auto;">
                <table class="analysis-table">
                  <thead><tr><th>#</th><th>節點</th><th>Δt (s)</th><th>瞬時速度 / RPM</th><th>備註</th></tr></thead>
                  <tbody id="gatePassesBody">${this.renderGatePassesHtml()}</tbody>
                </table>
              </div>
            </div>
          </div>
        </div>`;

      document.getElementById("gateSubModeSelect").onchange = (e) => {
        this.gateState.subMode = e.target.value;
      };
      document.getElementById("gateFlagCmInput").oninput = (e) => {
        this.gateState.flagCm = Math.max(0.1, Number(e.target.value) || 2.0);
      };
      document.getElementById("btnCalibrateGate").onclick = () => {
        const firstBucket = [...this.nodes.values()][0];
        const ambient = firstBucket?.latest?.luminance ?? 200;
        const newThresh = Math.max(10, Math.round(ambient * 0.5));
        this.gateState.threshold = newThresh;
        this.sync.broadcastCommand({ cmd: "SET_PHOTOGATE_THRESHOLD", threshold: newThresh });
        document.getElementById("gateLiveStatus").textContent = `✅ 已自動校準環境光 (${ambient}) → 遮光閾值設為 ${newThresh}`;
      };
      document.getElementById("btnClearGateTable").onclick = () => {
        this.gateState.passes = [];
        this.gateState.lastGateA = null;
        this.gateState.lastPassTime = null;
        document.getElementById("gatePassesBody").innerHTML = this.renderGatePassesHtml();
      };
      this.bindCommonLabButtons(() => this.exportGateCsv());
    }
  }

  bindCommonLabButtons(csvHandler) {
    const zeroBtn = document.getElementById("labCmdZero");
    if (zeroBtn) {
      zeroBtn.onclick = () => this.sync.broadcastCommand({ cmd: "ZERO_TARE" });
    }
    const csvBtn = document.getElementById("labBtnExportCsv");
    if (csvBtn) {
      csvBtn.onclick = () => {
        try {
          csvHandler();
        } catch (err) {
          alert(err.message || err);
        }
      };
    }
  }

  renderNodeBadgesHtml() {
    if (this.nodes.size === 0) {
      return `<span class="analysis-count-badge">尚無感測手機連線</span>`;
    }
    return [...this.nodes.values()].map(n =>
      `<span class="lab-node-pill" style="border-color:${n.color};color:${n.color};">● ${n.id}</span>`
    ).join("");
  }

  refreshNodeBadges() {
    const el = document.getElementById("labNodeBadges");
    if (el) el.innerHTML = this.renderNodeBadgesHtml();
  }

  // --- 各模組數據處理與運算 ---

  computeTrapezoidalDeltaV(samples) {
    if (!samples || samples.length < 2) return null;
    let dv = 0;
    for (let i = 1; i < samples.length; i++) {
      const dt = Math.max(0, samples[i].t - samples[i - 1].t);
      dv += 0.5 * (samples[i].a + samples[i - 1].a) * dt;
    }
    return { dv, dt: samples[samples.length - 1].t - samples[0].t };
  }

  processInclineEvents(nodeId, rec) {
    if (this.activeMode !== "INCLINE_GYRO") return;
    // 最大靜摩擦滑動捕捉
    if (!this.inclineState.slipLocked && Math.abs(rec.linAcc || 0) > 0.3 && Math.abs(rec.beta || 0) > 2) {
      const theta = Math.abs(rec.beta);
      const mu = Math.tan((theta * Math.PI) / 180);
      this.inclineState.slipLocked = true;
      this.inclineState.slipThetaDeg = theta;
      this.inclineState.slipMu = mu;
    }
    // 單擺角速度過零偵測
    const w = rec.omega || 0;
    if (Math.abs(w) > 0.08) {
      const sign = w > 0 ? 1 : -1;
      if (this.inclineState.prevOmegaSign !== 0 && sign !== this.inclineState.prevOmegaSign) {
        const tSec = rec.t / 1000;
        const zc = this.inclineState.zeroCrossTimes;
        if (zc.length === 0 || (tSec - zc[zc.length - 1]) > 0.15) {
          zc.push(tSec);
          if (zc.length > 8) zc.shift();
          if (zc.length >= 3) {
            // 連續兩次同向半週期總和 = 1 完整週期 T
            const T = zc[zc.length - 1] - zc[zc.length - 3];
            if (T > 0.25 && T < 10) {
              this.inclineState.pendulumPeriod = T;
              this.inclineState.pendulumG = (4 * Math.PI * Math.PI * this.inclineState.pendulumLenM) / (T * T);
            }
          }
        }
      }
      this.inclineState.prevOmegaSign = sign;
    }
  }

  processAcousticTimerEvent(nodeId, data) {
    if (data.event === "VU") {
      this.timerState.vuLevel = data.level || 0;
      const bar = document.getElementById("timerVuBar");
      if (bar) {
        const pct = Math.min(100, Math.round((data.level || 0) * 100));
        bar.style.width = `${pct}%`;
        bar.style.background = (data.level >= this.timerState.threshold) ? "#ef4444" : "#38bdf8";
      }
      return;
    }
    if (data.event !== "TRIGGER") return;

    const st = this.timerState;
    if (!st.armed) return;
    if (st.t1 === null) {
      st.t1 = data.audioTime;
      const stepEl = document.getElementById("timerStepText");
      if (stepEl) stepEl.textContent = `🟡 已收到第 1 聲 (t₁=${st.t1.toFixed(4)}s)，等待撞擊第 2 聲...`;
    } else {
      st.t2 = data.audioTime;
      const dt = Math.max(0.001, st.t2 - st.t1);
      const gExp = (2 * st.heightM) / (dt * dt);
      const errPct = ((gExp - 9.80665) / 9.80665) * 100;
      st.trials.unshift({
        idx: st.trials.length + 1,
        h: st.heightM,
        dt,
        g: gExp,
        errPct
      });
      st.armed = false;

      const stepEl = document.getElementById("timerStepText");
      const dtEl = document.getElementById("timerDeltaReadout");
      const gEl = document.getElementById("timerGReadout");
      const tbody = document.getElementById("timerTrialsBody");
      if (stepEl) stepEl.textContent = "✅ 完成計時！按「🎯 重新待命」可進行下一輪測量";
      if (dtEl) dtEl.textContent = `Δt = ${dt.toFixed(4)} s`;
      if (gEl) gEl.textContent = `實驗 g = ${gExp.toFixed(2)} m/s² (誤差 ${errPct >= 0 ? "+" : ""}${errPct.toFixed(1)}%)`;
      if (tbody) tbody.innerHTML = this.renderTimerTrialsHtml();
    }
  }

  renderTimerTrialsHtml() {
    if (this.timerState.trials.length === 0) {
      return `<tr><td colspan="5" style="text-align:center;color:#64748b;padding:24px;">尚無測量紀錄</td></tr>`;
    }
    return this.timerState.trials.map(r => `
      <tr>
        <td>${r.idx}</td>
        <td>${r.h.toFixed(2)}</td>
        <td>${r.dt.toFixed(4)}</td>
        <td style="color:#10b981;font-weight:bold;">${r.g.toFixed(2)}</td>
        <td>${r.errPct >= 0 ? "+" : ""}${r.errPct.toFixed(1)}%</td>
      </tr>
    `).join("");
  }

  processPhotogateEvent(nodeId, data, tsMs) {
    if (data.state === "OPEN" && data.duration > 0) {
      const st = this.gateState;
      const dMeters = st.flagCm / 100;
      const speed = dMeters / data.duration;
      let note = `v = ${speed.toFixed(3)} m/s`;
      let metricText = `${speed.toFixed(3)} m/s`;

      if (st.subMode === "dual") {
        if (!st.lastGateA || st.lastGateA.nodeId === nodeId) {
          st.lastGateA = { nodeId, v: speed, tMs: tsMs };
          note = "等待另一光電閘通過...";
        } else {
          const dtAB = Math.max(0.001, (tsMs - st.lastGateA.tMs) / 1000);
          const acc = (speed - st.lastGateA.v) / dtAB;
          note = `a = ${acc.toFixed(2)} m/s² (Δt=${dtAB.toFixed(3)}s)`;
          st.lastGateA = null;
        }
      } else if (st.subMode === "rpm") {
        if (st.lastPassTime !== null) {
          const dtRev = Math.max(0.005, (tsMs - st.lastPassTime) / 1000);
          const rpm = 60 / dtRev;
          metricText = `${rpm.toFixed(1)} RPM`;
          note = `週期 T = ${dtRev.toFixed(3)} s`;
        }
        st.lastPassTime = tsMs;
      }

      st.passes.unshift({
        idx: st.passes.length + 1,
        nodeId,
        duration: data.duration,
        metricText,
        note
      });
      if (st.passes.length > 100) st.passes.pop();
      const tbody = document.getElementById("gatePassesBody");
      if (tbody) tbody.innerHTML = this.renderGatePassesHtml();
    }
  }

  renderGatePassesHtml() {
    if (this.gateState.passes.length === 0) {
      return `<tr><td colspan="5" style="text-align:center;color:#64748b;padding:24px;">等待物體掠過手機鏡頭...</td></tr>`;
    }
    return this.gateState.passes.map(p => `
      <tr>
        <td>${p.idx}</td>
        <td>${p.nodeId}</td>
        <td>${p.duration.toFixed(4)}</td>
        <td style="color:#38bdf8;font-weight:bold;">${p.metricText}</td>
        <td>${p.note}</td>
      </tr>
    `).join("");
  }

  // --- 動畫渲染循環 ---

  renderActiveCanvas() {
    this.refreshNodeBadges();

    if (this.activeMode === "ACCEL_3D") {
      const first = [...this.nodes.values()][0]?.latest;
      this.drawAccel3DBox(document.getElementById("accel3dCanvas"), first);
      this.drawRollingChart(document.getElementById("accelChartCanvas"), {
        valueKey: this.accelState.axisKey,
        yMin: -25,
        yMax: 25,
        unit: "m/s²",
        title: `加速度 ${this.accelState.axisKey}(t)`
      });
      if (first) {
        const az = Number(first.az ?? 9.81);
        const mass = this.accelState.massKg;
        const newton = Math.max(0, mass * Math.abs(az));
        const eqKg = newton / 9.81;
        const wEl = document.getElementById("accelWeightReadout");
        const sEl = document.getElementById("accelStateBadge");
        if (wEl) wEl.textContent = `${eqKg.toFixed(1)} kgf (${newton.toFixed(1)} N)`;
        if (sEl) {
          if (Math.abs(az) < 2.0) {
            sEl.textContent = "🪶 接近自由落體失重狀態";
            sEl.style.color = "#f59e0b";
          } else if (Math.abs(az) > 11.2) {
            sEl.textContent = "⚡ 超重狀態 (向上加速 / 觸地反彈)";
            sEl.style.color = "#FF595E";
          } else if (Math.abs(az) < 8.4) {
            sEl.textContent = "⬇️ 失重狀態 (向下加速)";
            sEl.style.color = "#38bdf8";
          } else {
            sEl.textContent = "⚖️ 正常等重狀態";
            sEl.style.color = "#10b981";
          }
        }
      }
    } else if (this.activeMode === "INCLINE_GYRO") {
      const first = [...this.nodes.values()][0]?.latest;
      this.drawInclineDiagram(document.getElementById("inclineCanvas"), first);
      const frEl = document.getElementById("frictionReadout");
      const fhEl = document.getElementById("frictionHint");
      if (this.inclineState.slipLocked && frEl && fhEl) {
        frEl.textContent = `θs = ${this.inclineState.slipThetaDeg.toFixed(1)}° | μs = ${this.inclineState.slipMu.toFixed(3)}`;
        fhEl.textContent = "🔒 已鎖定最大靜摩擦滑動臨界角！按「重新偵測」可再測一次";
      } else if (first && frEl) {
        frEl.textContent = `即時傾角 θ = ${Math.abs(first.beta || 0).toFixed(1)}°`;
      }
      const pEl = document.getElementById("pendulumReadout");
      if (pEl && this.inclineState.pendulumPeriod) {
        pEl.textContent = `T = ${this.inclineState.pendulumPeriod.toFixed(3)} s | g = ${this.inclineState.pendulumG.toFixed(2)} m/s²`;
      }
    } else if (this.activeMode === "AUDIO_FFT") {
      const first = [...this.nodes.values()][0]?.latest;
      if (first) {
        const pf = document.getElementById("audioPeakFreqText");
        const nt = document.getElementById("audioNoteText");
        const db = document.getElementById("audioDbText");
        if (pf) pf.textContent = `${(first.peakFreq || 0).toFixed(1)} Hz`;
        if (nt) {
          const info = freqToNoteName(first.peakFreq);
          nt.textContent = info.note === "--" ? "--" : `${info.note} (${info.cents >= 0 ? "+" : ""}${info.cents}¢)`;
        }
        if (db) db.textContent = `${(first.db || -96).toFixed(1)} dB`;
      }
      this.drawAudioSpectrum(document.getElementById("audioFftCanvas"));
    } else if (this.activeMode === "CAM_PHOTOGATE") {
      this.drawRollingChart(document.getElementById("gateFluxCanvas"), {
        valueKey: "luminance",
        yMin: 0,
        yMax: 255,
        unit: "0-255",
        title: "光通量變化曲線 (Luminance)",
        thresholdLine: this.gateState.threshold
      });
    }
  }

  drawAccel3DBox(canvas, data) {
    const meta = this.syncCanvasSize(canvas);
    if (!meta) return;
    const { ctx, w, h, dpr } = meta;
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const ax = data?.ax || 0;
    const ay = data?.ay || 0;
    const az = data?.az ?? 9.81;

    // 簡易 3D 透視傾斜 (依重力方向近似手機俯仰與側傾)
    const pitch = Math.atan2(ay, az) * 0.6;
    const roll = Math.atan2(ax, az) * 0.6;
    const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
    const cosR = Math.cos(roll), sinR = Math.sin(roll);

    const project = (x, y, z) => {
      const x1 = x * cosR - z * sinR;
      const z1 = x * sinR + z * cosR;
      const y2 = y * cosP - z1 * sinP;
      const z2 = y * sinP + z1 * cosP;
      const scale = 320 / (320 + z2);
      return { x: cx + x1 * scale * dpr, y: cy + y2 * scale * dpr };
    };

    const bw = 46, bh = 84, bd = 7;
    const verts = [
      [-bw, -bh, -bd], [bw, -bh, -bd], [bw, bh, -bd], [-bw, bh, -bd],
      [-bw, -bh, bd], [bw, -bh, bd], [bw, bh, bd], [-bw, bh, bd]
    ].map(v => project(v[0], v[1], v[2]));

    const edges = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7]
    ];

    ctx.save();
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    edges.forEach(([a, b]) => {
      ctx.moveTo(verts[a].x, verts[a].y);
      ctx.lineTo(verts[b].x, verts[b].y);
    });
    ctx.stroke();

    // 合加速度向量箭頭
    const scaleVec = 6;
    const endPt = project(ax * scaleVec, -ay * scaleVec, az * scaleVec);
    ctx.strokeStyle = "#FF595E";
    ctx.fillStyle = "#FF595E";
    ctx.lineWidth = 3.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(endPt.x, endPt.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(endPt.x, endPt.y, 5 * dpr, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#e2e8f0";
    ctx.font = `${12 * dpr}px monospace`;
    ctx.fillText(`a=(${ax.toFixed(2)}, ${ay.toFixed(2)}, ${az.toFixed(2)}) m/s²`, 14 * dpr, h - 14 * dpr);
    ctx.restore();
  }

  drawInclineDiagram(canvas, data) {
    const meta = this.syncCanvasSize(canvas);
    if (!meta) return;
    const { ctx, w, h, dpr } = meta;
    ctx.clearRect(0, 0, w, h);

    const deg = Math.max(-85, Math.min(85, Number(data?.beta || 0)));
    const rad = (deg * Math.PI) / 180;
    const g = 9.81;
    const m = this.inclineState.massKg;
    const mg = m * g;
    const fParallel = mg * Math.sin(Math.abs(rad));
    const fNormal = mg * Math.cos(Math.abs(rad));

    ctx.save();
    const baseY = h * 0.78;
    const baseLeft = w * 0.14;
    const baseRight = w * 0.86;
    const planeLen = baseRight - baseLeft;
    const topH = Math.min(h * 0.58, Math.tan(Math.abs(rad)) * planeLen);

    // 繪製直角斜面三角形
    ctx.fillStyle = "rgba(56, 189, 248, 0.14)";
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 2.5 * dpr;
    ctx.beginPath();
    ctx.moveTo(baseLeft, baseY);
    ctx.lineTo(baseRight, baseY);
    ctx.lineTo(deg >= 0 ? baseRight : baseLeft, baseY - topH);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 木塊中心
    const midX = (baseLeft + baseRight) / 2;
    const midY = baseY - topH / 2 - 18 * dpr;
    const slopeAngle = deg >= 0 ? -Math.atan2(topH, planeLen) : Math.atan2(topH, planeLen);

    ctx.save();
    ctx.translate(midX, midY);
    ctx.rotate(slopeAngle);
    ctx.fillStyle = "#f59e0b";
    ctx.fillRect(-26 * dpr, -16 * dpr, 52 * dpr, 32 * dpr);
    ctx.restore();

    const drawArrow = (x1, y1, x2, y2, color, label) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 3 * dpr;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      const ang = Math.atan2(y2 - y1, x2 - x1);
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - 10 * dpr * Math.cos(ang - 0.4), y2 - 10 * dpr * Math.sin(ang - 0.4));
      ctx.lineTo(x2 - 10 * dpr * Math.cos(ang + 0.4), y2 - 10 * dpr * Math.sin(ang + 0.4));
      ctx.closePath();
      ctx.fill();
      ctx.font = `bold ${12 * dpr}px monospace`;
      ctx.fillText(label, x2 + 8 * dpr, y2 + 4 * dpr);
      ctx.restore();
    };

    const pxScale = Math.min(110 * dpr, h * 0.28);
    // 重力 mg (垂直向下)
    drawArrow(midX, midY, midX, midY + pxScale, "#FF595E", `mg = ${mg.toFixed(1)} N`);
    // 下滑分力 mgsinθ
    const sinSign = deg >= 0 ? -1 : 1;
    const parLen = (fParallel / mg) * pxScale;
    drawArrow(
      midX, midY,
      midX + sinSign * parLen * Math.cos(Math.abs(slopeAngle)),
      midY + parLen * Math.sin(Math.abs(slopeAngle)),
      "#8AC926",
      `mg sinθ = ${fParallel.toFixed(1)} N`
    );
    // 正向力 N = mgcosθ
    const normLen = (fNormal / mg) * pxScale;
    drawArrow(
      midX, midY,
      midX - sinSign * normLen * Math.sin(Math.abs(slopeAngle)),
      midY - normLen * Math.cos(Math.abs(slopeAngle)),
      "#38bdf8",
      `N = ${fNormal.toFixed(1)} N`
    );

    ctx.fillStyle = "#f8fafc";
    ctx.font = `bold ${14 * dpr}px monospace`;
    ctx.fillText(`θ = ${deg.toFixed(1)}°`, 18 * dpr, 28 * dpr);
    ctx.restore();
  }

  drawAudioSpectrum(canvas) {
    const meta = this.syncCanvasSize(canvas);
    if (!meta) return;
    const { ctx, w, h, dpr } = meta;
    ctx.clearRect(0, 0, w, h);

    const pad = { l: 46 * dpr, r: 16 * dpr, t: 24 * dpr, b: 30 * dpr };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;

    if (this.audioState.viewMode === "waterfall") {
      const rows = this.audioState.waterfallRows;
      if (rows.length === 0) return;
      const rowH = ph / Math.max(1, rows.length);
      rows.forEach((spec, rIdx) => {
        const y = pad.t + ph - (rIdx + 1) * rowH;
        const bw = pw / spec.length;
        for (let i = 0; i < spec.length; i++) {
          const val = spec[i] || 0;
          const hue = 220 - (val / 255) * 200;
          ctx.fillStyle = `hsla(${hue}, 90%, ${15 + (val / 255) * 55}%, 0.95)`;
          ctx.fillRect(pad.l + i * bw, y, Math.ceil(bw), Math.ceil(rowH));
        }
      });
      return;
    }

    const startHz = this.audioState.beatZoom ? 350 : 0;
    const endHz = this.audioState.beatZoom ? 550 : 4000;
    const binHz = 4000 / 128;
    const bStart = Math.floor(startHz / binHz);
    const bEnd = Math.min(127, Math.ceil(endHz / binHz));
    const spanBins = Math.max(1, bEnd - bStart + 1);

    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.1)";
    ctx.fillStyle = "#94a3b8";
    ctx.font = `${11 * dpr}px monospace`;
    ctx.textAlign = "center";

    for (let i = 0; i <= 5; i++) {
      const hz = startHz + (i / 5) * (endHz - startHz);
      const x = pad.l + (i / 5) * pw;
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + ph);
      ctx.stroke();
      ctx.fillText(`${Math.round(hz)}Hz`, x, pad.t + ph + 16 * dpr);
    }

    for (const bucket of this.nodes.values()) {
      const spec = bucket.latest?.spectrum;
      if (!spec || spec.length === 0) continue;

      ctx.strokeStyle = bucket.color;
      ctx.fillStyle = bucket.color;
      ctx.lineWidth = 2.5 * dpr;

      if (this.nodes.size === 1 && !this.audioState.beatZoom) {
        const barW = Math.max(2 * dpr, (pw / spanBins) * 0.72);
        for (let b = bStart; b <= bEnd; b++) {
          const val = spec[b] || 0;
          const x = pad.l + ((b - bStart) / spanBins) * pw;
          const bh = (val / 255) * ph;
          ctx.globalAlpha = 0.78;
          ctx.fillRect(x, pad.t + ph - bh, barW, bh);
        }
        ctx.globalAlpha = 1;
      } else {
        ctx.beginPath();
        for (let b = bStart; b <= bEnd; b++) {
          const val = spec[b] || 0;
          const x = pad.l + ((b - bStart) / (spanBins - 1 || 1)) * pw;
          const y = pad.t + ph - (val / 255) * ph;
          if (b === bStart) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }

    // 標示基頻與泛音 (f0, 2f0, 3f0)
    const firstPeak = [...this.nodes.values()][0]?.latest?.peakFreq || 0;
    if (firstPeak > 40) {
      [1, 2, 3].forEach(hMult => {
        const f = firstPeak * hMult;
        if (f >= startHz && f <= endHz) {
          const fx = pad.l + ((f - startHz) / (endHz - startHz)) * pw;
          ctx.strokeStyle = "rgba(250, 204, 21, 0.7)";
          ctx.setLineDash([4 * dpr, 4 * dpr]);
          ctx.beginPath();
          ctx.moveTo(fx, pad.t);
          ctx.lineTo(fx, pad.t + ph);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = "#fef08a";
          ctx.fillText(`${hMult === 1 ? "f₀" : `${hMult}f₀`}`, fx, pad.t + 12 * dpr);
        }
      });
    }
    ctx.restore();
  }

  // --- CSV 匯出 ---

  exportAccelCsv() {
    const rows = [];
    for (const bucket of this.nodes.values()) {
      for (const s of bucket.samples) {
        rows.push([bucket.id, (s.t / 1000).toFixed(4), s.ax, s.ay, s.az, s.lax, s.lay, s.laz]);
      }
    }
    exportCsvRows("accel_3d", ["節點", "時間(s)", "ax", "ay", "az", "lax", "lay", "laz"], rows);
  }

  exportInclineCsv() {
    const rows = [];
    for (const bucket of this.nodes.values()) {
      for (const s of bucket.samples) {
        rows.push([bucket.id, (s.t / 1000).toFixed(4), s.beta, s.gamma, s.omega, s.linAcc]);
      }
    }
    exportCsvRows("incline_gyro", ["節點", "時間(s)", "beta(deg)", "gamma(deg)", "omega(rad/s)", "linAcc(m/s^2)"], rows);
  }

  exportAudioCsv() {
    const rows = this.audioState.history.map(h => [h.id, (h.t / 1000).toFixed(4), h.peakFreq, h.db, h.rms]);
    exportCsvRows("audio_fft", ["節點", "時間(s)", "主頻率(Hz)", "分貝(dB)", "RMS"], rows);
  }

  exportTimerCsv() {
    const rows = this.timerState.trials.map(t => [t.idx, t.h, t.dt.toFixed(5), t.g.toFixed(4), `${t.errPct.toFixed(2)}%`]);
    exportCsvRows("acoustic_timer_g", ["次序", "高度h(m)", "時間差Δt(s)", "實驗g(m/s²)", "誤差百分比"], rows);
  }

  exportGateCsv() {
    const rows = this.gateState.passes.map(p => [p.idx, p.nodeId, p.duration.toFixed(4), p.metricText, p.note]);
    exportCsvRows("cam_photogate", ["次序", "節點", "遮光時間Δt(s)", "瞬時速率/轉速", "備註"], rows);
  }
}
