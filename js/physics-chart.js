/**
 * physics-chart.js
 * 大屏端即時物理圖表引擎
 * 支援：x-t, y-t (位移), v-t (速度), a-t (加速度) 圖表
 * 具備 X 軸、Y 軸分量切換與隨影片播放動態同步繪製功能
 */

export class PhysicsChart {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.type = options.type || "xt"; // "xt" | "vt" | "at"
    this.axisFilter = options.axisFilter || "all"; // "all" | "x" | "y"
    this.drawMode = options.drawMode || "dynamic"; // "dynamic" (隨播放繪製) | "full" (全曲線+掃描光點)
    this.trajectory = [];
    this.duration = 2.5;

    // 配色定義 (與大屏 HUD 與向量箭頭一致)
    this.colors = {
      x: "#38bdf8",       // X 分量: 科技青藍
      y: "#f59e0b",       // Y 分量: 琥珀金橙
      mag: "#10b981",     // 合成量大小: 螢光綠
      accY: "#ef4444",    // Y 加速度: 警示亮紅
      grid: "rgba(255, 255, 255, 0.08)",
      axis: "rgba(255, 255, 255, 0.25)",
      zeroLine: "rgba(255, 255, 255, 0.35)",
      cursor: "rgba(255, 255, 255, 0.8)",
      text: "#94a3b8",
      textHighlight: "#f8fafc"
    };

    this.padding = { left: 55, right: 25, top: 32, bottom: 32 };
  }

  setData(trajectory, duration = null) {
    this.trajectory = trajectory || [];
    if (duration) {
      this.duration = duration;
    } else if (this.trajectory.length > 0) {
      this.duration = this.trajectory[this.trajectory.length - 1].t;
    }
  }

  setType(type) {
    if (["xt", "vt", "at"].includes(type)) {
      this.type = type;
    }
  }

  setAxisFilter(filter) {
    if (["all", "x", "y"].includes(filter)) {
      this.axisFilter = filter;
    }
  }

  setDrawMode(mode) {
    if (["dynamic", "full"].includes(mode)) {
      this.drawMode = mode;
    }
  }

  syncSize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.floor(rect.width * dpr);
    const targetH = Math.floor(rect.height * dpr);

    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
  }

  /**
   * 取得指定時間點的插值數據
   */
  interpolate(t) {
    if (!this.trajectory || this.trajectory.length === 0) return null;
    if (t <= this.trajectory[0].t) return this.trajectory[0];
    if (t >= this.trajectory[this.trajectory.length - 1].t) {
      return this.trajectory[this.trajectory.length - 1];
    }

    // 二分搜尋
    let low = 0;
    let high = this.trajectory.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (this.trajectory[mid].t < t) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const i0 = Math.max(0, low - 1);
    const i1 = Math.min(this.trajectory.length - 1, low);
    if (i0 === i1) return this.trajectory[i0];

    const p0 = this.trajectory[i0];
    const p1 = this.trajectory[i1];
    const ratio = (t - p0.t) / (p1.t - p0.t);

    const lerp = (a, b) => a + (b - a) * ratio;

    return {
      t: t,
      meterX: lerp(p0.meterX, p1.meterX),
      meterY: lerp(p0.meterY, p1.meterY),
      vx: lerp(p0.vx, p1.vx),
      vy: lerp(p0.vy, p1.vy),
      v: lerp(p0.v, p1.v),
      ax: lerp(p0.ax, p1.ax),
      ay: lerp(p0.ay, p1.ay),
      a: lerp(p0.a, p1.a)
    };
  }

  /**
   * 繪製核心
   * @param {number} currentTime 當前影片播放時間 (秒)
   */
  render(currentTime = 0) {
    this.syncSize();
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.clearRect(0, 0, w, h);

    if (!this.trajectory || this.trajectory.length < 2) {
      this.drawEmptyState(ctx, w, h);
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const pad = {
      left: this.padding.left * dpr,
      right: this.padding.right * dpr,
      top: this.padding.top * dpr,
      bottom: this.padding.bottom * dpr
    };

    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;
    if (plotW <= 0 || plotH <= 0) return;

    // 1. 決定資料序列與 Y 軸範圍
    const seriesConfig = this.getSeriesConfig();
    const { minY, maxY } = this.calculateYRange(seriesConfig);

    // 座標映射函數
    const tMax = Math.max(this.duration, this.trajectory[this.trajectory.length - 1].t, 0.1);
    const mapX = (t) => pad.left + (t / tMax) * plotW;
    const mapY = (val) => pad.top + plotH - ((val - minY) / (maxY - minY)) * plotH;

    // 2. 繪製背景網格與座標刻度
    this.drawGridAndAxes(ctx, pad, plotW, plotH, tMax, minY, maxY, mapX, mapY, seriesConfig.unit, dpr);

    // 3. 繪製物理曲線
    seriesConfig.lines.forEach(line => {
      this.drawSeriesLine(ctx, line, mapX, mapY, currentTime, dpr);
    });

    // 4. 繪製當前時間指示線 (Scanning Cursor) 與指示光點
    this.drawCurrentTimeCursor(ctx, pad, plotH, currentTime, tMax, mapX, mapY, seriesConfig, dpr);

    // 5. 繪製圖例 (Legend) 與即時數據看板
    this.drawLegendAndHud(ctx, pad, seriesConfig, currentTime, dpr);
  }

  getSeriesConfig() {
    if (this.type === "xt") {
      const lines = [];
      if (this.axisFilter === "all" || this.axisFilter === "x") {
        lines.push({ key: "meterX", name: "X軸位移 (x)", color: this.colors.x });
      }
      if (this.axisFilter === "all" || this.axisFilter === "y") {
        lines.push({ key: "meterY", name: "Y軸位移 (y)", color: this.colors.y });
      }
      return { title: "位移 - 時間圖 (x-t / y-t)", unit: "m", lines };
    } else if (this.type === "vt") {
      const lines = [];
      if (this.axisFilter === "all" || this.axisFilter === "x") {
        lines.push({ key: "vx", name: "X速度 (vx)", color: this.colors.x });
      }
      if (this.axisFilter === "all" || this.axisFilter === "y") {
        lines.push({ key: "vy", name: "Y速度 (vy)", color: this.colors.y });
      }
      if (this.axisFilter === "all") {
        lines.push({ key: "v", name: "合速度 (|v|)", color: this.colors.mag, dash: [4, 4] });
      }
      return { title: "速度 - 時間圖 (v-t)", unit: "m/s", lines };
    } else {
      // at
      const lines = [];
      if (this.axisFilter === "all" || this.axisFilter === "x") {
        lines.push({ key: "ax", name: "X加速度 (ax)", color: this.colors.x });
      }
      if (this.axisFilter === "all" || this.axisFilter === "y") {
        lines.push({ key: "ay", name: "Y加速度 (ay)", color: this.colors.accY });
      }
      return { title: "加速度 - 時間圖 (a-t)", unit: "m/s²", lines };
    }
  }

  calculateYRange(config) {
    let minY = Infinity;
    let maxY = -Infinity;

    for (const pt of this.trajectory) {
      for (const line of config.lines) {
        const val = pt[line.key];
        if (val !== undefined && !isNaN(val)) {
          if (val < minY) minY = val;
          if (val > maxY) maxY = val;
        }
      }
    }

    if (minY === Infinity || maxY === -Infinity) {
      minY = -1;
      maxY = 1;
    }

    // 包含 0 刻度以利物理觀察
    if (minY > 0) minY = 0;
    if (maxY < 0) maxY = 0;

    const span = Math.max(maxY - minY, 0.5);
    const margin = span * 0.15; // 15% 上下留白
    return {
      minY: minY - margin,
      maxY: maxY + margin
    };
  }

  drawGridAndAxes(ctx, pad, plotW, plotH, tMax, minY, maxY, mapX, mapY, unit, dpr) {
    ctx.save();
    ctx.lineWidth = 1 * dpr;
    ctx.strokeStyle = this.colors.grid;
    ctx.fillStyle = this.colors.text;
    ctx.font = `${11 * dpr}px -apple-system, sans-serif`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    // 水平網格與 Y 刻度 (5 條)
    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
      const val = minY + (i / ySteps) * (maxY - minY);
      const y = mapY(val);

      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();

      ctx.fillText(`${val.toFixed(1)} ${unit}`, pad.left - 6 * dpr, y);
    }

    // 0 基準水平線強調
    if (minY <= 0 && maxY >= 0) {
      const zeroY = mapY(0);
      ctx.beginPath();
      ctx.strokeStyle = this.colors.zeroLine;
      ctx.lineWidth = 1.5 * dpr;
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.moveTo(pad.left, zeroY);
      ctx.lineTo(pad.left + plotW, zeroY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 垂直網格與時間刻度 (X 軸)
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.strokeStyle = this.colors.grid;
    ctx.lineWidth = 1 * dpr;

    const tSteps = 5;
    for (let i = 0; i <= tSteps; i++) {
      const t = (i / tSteps) * tMax;
      const x = mapX(t);

      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, pad.top + plotH);
      ctx.stroke();

      ctx.fillText(`${t.toFixed(1)}s`, x, pad.top + plotH + 8 * dpr);
    }

    // 主座標軸外框
    ctx.strokeStyle = this.colors.axis;
    ctx.strokeRect(pad.left, pad.top, plotW, plotH);
    ctx.restore();
  }

  drawSeriesLine(ctx, line, mapX, mapY, currentTime, dpr) {
    const pts = this.trajectory;
    if (pts.length < 2) return;

    ctx.save();
    ctx.lineWidth = 2.5 * dpr;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (this.drawMode === "full") {
      // 繪製完整實線
      ctx.strokeStyle = line.color;
      if (line.dash) ctx.setLineDash(line.dash.map(v => v * dpr));
      ctx.beginPath();
      pts.forEach((p, idx) => {
        const x = mapX(p.t);
        const y = mapY(p[line.key]);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    } else {
      // dynamic 模式：淡色虛線繪製未來路徑，飽和實線繪製目前已播放路徑
      ctx.strokeStyle = line.color;
      ctx.globalAlpha = 0.25;
      ctx.beginPath();
      pts.forEach((p, idx) => {
        const x = mapX(p.t);
        const y = mapY(p[line.key]);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // 已播放實線
      ctx.globalAlpha = 1.0;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        if (p.t <= currentTime) {
          const x = mapX(p.t);
          const y = mapY(p[line.key]);
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            ctx.lineTo(x, y);
          }
        } else {
          // 插值到精確 currentTime
          const interp = this.interpolate(currentTime);
          if (interp && interp[line.key] !== undefined) {
            ctx.lineTo(mapX(currentTime), mapY(interp[line.key]));
          }
          break;
        }
      }
      ctx.stroke();
    }

    ctx.restore();
  }

  drawCurrentTimeCursor(ctx, pad, plotH, currentTime, tMax, mapX, mapY, seriesConfig, dpr) {
    const curX = mapX(currentTime);
    if (curX < pad.left || curX > pad.left + (mapX(tMax) - pad.left)) return;

    ctx.save();
    // 垂直掃描指示線
    ctx.strokeStyle = this.colors.cursor;
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.beginPath();
    ctx.moveTo(curX, pad.top);
    ctx.lineTo(curX, pad.top + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    // 當前時間各曲線高亮指示光點
    const interp = this.interpolate(currentTime);
    if (interp) {
      seriesConfig.lines.forEach(line => {
        const val = interp[line.key];
        if (val !== undefined) {
          const curY = mapY(val);

          // 光暈外圈
          ctx.beginPath();
          ctx.fillStyle = line.color;
          ctx.globalAlpha = 0.35;
          ctx.arc(curX, curY, 8 * dpr, 0, Math.PI * 2);
          ctx.fill();

          // 核心白點
          ctx.globalAlpha = 1.0;
          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.arc(curX, curY, 3.5 * dpr, 0, Math.PI * 2);
          ctx.fill();
        }
      });
    }

    ctx.restore();
  }

  drawLegendAndHud(ctx, pad, config, currentTime, dpr) {
    ctx.save();
    ctx.font = `bold ${12 * dpr}px -apple-system, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    // 標題
    ctx.fillStyle = this.colors.textHighlight;
    ctx.fillText(config.title, pad.left, pad.top - 16 * dpr);

    // 插值即時數據
    const interp = this.interpolate(currentTime);

    // 圖例項目與即時讀數
    let offsetX = pad.left + 160 * dpr;
    ctx.font = `${11 * dpr}px monospace`;

    config.lines.forEach(line => {
      // 色塊
      ctx.fillStyle = line.color;
      ctx.fillRect(offsetX, pad.top - 20 * dpr, 10 * dpr, 8 * dpr);

      // 文字
      let label = line.name;
      if (interp && interp[line.key] !== undefined) {
        label += `: ${interp[line.key].toFixed(2)} ${config.unit}`;
      }

      ctx.fillStyle = this.colors.text;
      ctx.fillText(label, offsetX + 14 * dpr, pad.top - 16 * dpr);
      offsetX += ctx.measureText(label).width + 24 * dpr;
    });

    ctx.restore();
  }

  drawEmptyState(ctx, w, h) {
    ctx.save();
    ctx.fillStyle = this.colors.text;
    ctx.font = "14px -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("📊 載入影片並完成分析後，將在此即時繪製物理曲線", w / 2, h / 2);
    ctx.restore();
  }
}

