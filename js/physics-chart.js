/**
 * physics-chart.js
 * 大屏端即時物理圖表引擎
 * 支援：x-t, y-t (位移), v-t (速度), a-t (加速度) 圖表
 * 具備 X/Y 分量切換、動態同步繪製、Y/X 軸縮放平移與數據起伏自動聚焦功能
 */

export class PhysicsChart {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.type = options.type || "xt"; // "xt" | "vt" | "at"
    this.axisFilter = options.axisFilter || "all"; // "all" | "x" | "y"
    this.drawMode = options.drawMode || "dynamic"; // "dynamic" (隨播放繪製) | "full" (全曲線+掃描光點)
    this.trajectory = [];
    this.secondaryTrajectory = [];
    this.duration = 2.5;

    // 縮放與聚焦控制
    this.yZoom = 1.0;
    this.xZoom = 1.0;
    this.xPan = 0.0; // 0.0 ~ 1.0
    this.yPan = 0.0; // 物理數值位移
    this.focusDataRange = true; // 預設聚焦數據起伏區間 (避免 0 點或碰撞尖峰壓扁曲線)
    this.onZoomChange = options.onZoomChange || null;
    this.onPointSelect = options.onPointSelect || null;
    this.fitResult = null;
    this.selectedIndex = null;
    this.selectedTarget = "A";
    this.lastCurrentTime = 0;

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

    this.padding = { left: 60, right: 20, top: 34, bottom: 30 };
    this.initInteractions();
  }

  initInteractions() {
    let isDragging = false;
    let dragDistance = 0;
    let downClientX = 0;
    let downClientY = 0;
    let lastClientX = 0;
    let lastClientY = 0;

    this.canvas.style.cursor = "grab";

    // 滑鼠滾輪縮放 (預設縮放 Y 軸放大起伏，按住 Shift 縮放 X 軸時間)
    this.canvas.addEventListener("wheel", (e) => {
      if (!this.trajectory || this.trajectory.length < 2) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.25 : 1 / 1.25;
      if (e.shiftKey) {
        this.zoomX(factor);
      } else {
        this.zoomY(factor);
      }
      this.render(this.lastCurrentTime);
    }, { passive: false });

    this.canvas.addEventListener("mousedown", (e) => {
      if (!this.trajectory || this.trajectory.length < 2) return;
      isDragging = true;
      dragDistance = 0;
      downClientX = e.clientX;
      downClientY = e.clientY;
      lastClientX = e.clientX;
      lastClientY = e.clientY;
      this.canvas.style.cursor = "grabbing";
    });

    window.addEventListener("mousemove", (e) => {
      if (!isDragging) return;
      const dx = e.clientX - lastClientX;
      const dy = e.clientY - lastClientY;
      dragDistance += Math.hypot(dx, dy);
      lastClientX = e.clientX;
      lastClientY = e.clientY;

      if (dragDistance < 4) return;

      const rect = this.canvas.getBoundingClientRect();
      const plotW = Math.max(1, rect.width - this.padding.left - this.padding.right);
      const plotH = Math.max(1, rect.height - this.padding.top - this.padding.bottom);

      // 水平平移時間窗
      if (this.xZoom > 1.0) {
        const visibleRatio = 1 / this.xZoom;
        const maxPan = Math.max(0, 1 - visibleRatio);
        this.xPan = Math.min(maxPan, Math.max(0, this.xPan - (dx / plotW) * visibleRatio));
      }

      // 垂直平移 Y 數值窗
      const seriesConfig = this.getSeriesConfig();
      const { minY, maxY } = this.calculateYRange(seriesConfig);
      const spanY = maxY - minY;
      this.yPan += (dy / plotH) * spanY;

      this.render(this.lastCurrentTime);
    });

    window.addEventListener("mouseup", (e) => {
      if (!isDragging) return;
      isDragging = false;
      this.canvas.style.cursor = "grab";

      // 若移動距離極小，視為「點擊選取圖表上的點」
      if (dragDistance < 5 && this.trajectory && this.trajectory.length >= 2) {
        const rect = this.canvas.getBoundingClientRect();
        const clickX = downClientX - rect.left;
        const clickY = downClientY - rect.top;
        const plotW = rect.width - this.padding.left - this.padding.right;
        const plotH = rect.height - this.padding.top - this.padding.bottom;

        if (
          clickX >= this.padding.left && clickX <= this.padding.left + plotW &&
          clickY >= this.padding.top && clickY <= this.padding.top + plotH
        ) {
          const tStartAll = this.trajectory[0].t;
          const tEndAll = Math.max(this.trajectory[this.trajectory.length - 1].t, tStartAll + 0.1);
          const totalSpanT = tEndAll - tStartAll;
          const viewSpanT = totalSpanT / this.xZoom;
          const viewTMin = tStartAll + this.xPan * totalSpanT;
          const clickedT = viewTMin + ((clickX - this.padding.left) / plotW) * viewSpanT;

          let bestIdx = 0;
          let bestDiff = Infinity;
          for (let i = 0; i < this.trajectory.length; i++) {
            const diff = Math.abs(this.trajectory[i].t - clickedT);
            if (diff < bestDiff) {
              bestDiff = diff;
              bestIdx = i;
            }
          }
          this.setSelectedIndex(bestIdx);
          if (this.onPointSelect) {
            this.onPointSelect(bestIdx, this.trajectory[bestIdx]);
          }
          this.render(this.trajectory[bestIdx].t);
        }
      }
    });
  }

  setFitResult(fitResult) {
    this.fitResult = fitResult || null;
  }

  setSelectedIndex(index, target = "A") {
    this.selectedIndex = (index !== null && index !== undefined && index >= 0) ? index : null;
    this.selectedTarget = target === "B" ? "B" : "A";
  }

  setData(trajectory, duration = null, secondaryTrajectory = null) {
    this.trajectory = trajectory || [];
    this.secondaryTrajectory = secondaryTrajectory || [];
    if (duration && isFinite(duration)) {
      this.duration = duration;
    } else if (this.trajectory.length > 0) {
      this.duration = this.trajectory[this.trajectory.length - 1].t;
    }
    this.resetZoom();
  }

  setType(type) {
    if (["xt", "vt", "at"].includes(type)) {
      this.type = type;
      this.yPan = 0;
    }
  }

  setAxisFilter(filter) {
    if (["all", "x", "y"].includes(filter)) {
      this.axisFilter = filter;
      this.yPan = 0;
    }
  }

  setDrawMode(mode) {
    if (["dynamic", "full"].includes(mode)) {
      this.drawMode = mode;
    }
  }

  zoomY(factor) {
    this.yZoom = Math.min(50, Math.max(0.2, this.yZoom * factor));
    this.notifyZoom();
  }

  zoomX(factor) {
    const prevVisible = 1 / this.xZoom;
    this.xZoom = Math.min(20, Math.max(1.0, this.xZoom * factor));
    const newVisible = 1 / this.xZoom;
    this.xPan = Math.min(Math.max(0, 1 - newVisible), Math.max(0, this.xPan + (prevVisible - newVisible) / 2));
    this.notifyZoom();
  }

  toggleFocusMode() {
    this.focusDataRange = !this.focusDataRange;
    this.yPan = 0;
    this.notifyZoom();
    return this.focusDataRange;
  }

  resetZoom() {
    this.yZoom = 1.0;
    this.xZoom = 1.0;
    this.xPan = 0.0;
    this.yPan = 0.0;
    this.notifyZoom();
  }

  notifyZoom() {
    if (this.onZoomChange) {
      this.onZoomChange({
        yZoom: this.yZoom,
        xZoom: this.xZoom,
        focusDataRange: this.focusDataRange
      });
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
  interpolate(t, traj = this.trajectory) {
    if (!traj || traj.length === 0) return null;
    if (t <= traj[0].t) return traj[0];
    if (t >= traj[traj.length - 1].t) {
      return traj[traj.length - 1];
    }

    let low = 0;
    let high = traj.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (traj[mid].t < t) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const i0 = Math.max(0, low - 1);
    const i1 = Math.min(traj.length - 1, low);
    if (i0 === i1) return traj[i0];

    const p0 = traj[i0];
    const p1 = traj[i1];
    const dt = p1.t - p0.t;
    const ratio = dt > 0 ? (t - p0.t) / dt : 0;

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
    this.lastCurrentTime = currentTime;
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

    // 1. 決定資料序列、Y 軸與時間範圍 (支援縮放與平移)
    const seriesConfig = this.getSeriesConfig();
    const { minY, maxY } = this.calculateYRange(seriesConfig);

    const tStartAll = this.trajectory[0].t;
    const tEndAll = Math.max(this.trajectory[this.trajectory.length - 1].t, tStartAll + 0.1);
    const totalSpanT = tEndAll - tStartAll;
    const viewSpanT = totalSpanT / this.xZoom;
    const viewTMin = tStartAll + this.xPan * totalSpanT;
    const viewTMax = viewTMin + viewSpanT;

    const mapX = (t) => pad.left + ((t - viewTMin) / viewSpanT) * plotW;
    const mapY = (val) => pad.top + plotH - ((val - minY) / (maxY - minY)) * plotH;

    // 2. 繪製背景網格與座標刻度
    this.drawGridAndAxes(ctx, pad, plotW, plotH, viewTMin, viewTMax, minY, maxY, mapX, mapY, seriesConfig.unit, dpr);

    // 3. 裁切繪圖區域內繪製曲線與掃描游標
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.left, pad.top, plotW, plotH);
    ctx.clip();

    seriesConfig.lines.forEach(line => {
      this.drawSeriesLine(ctx, line, mapX, mapY, currentTime, dpr);
    });

    // 若有 Fitting 回歸結果且對應目前顯示的物理量，繪製亮紫色擬合曲線
    if (this.fitResult && seriesConfig.lines.some(l => l.key === this.fitResult.targetKey)) {
      this.drawFitCurve(ctx, this.fitResult, mapX, mapY, dpr);
    }

    this.drawCurrentTimeCursor(ctx, pad, plotH, currentTime, viewTMin, viewTMax, mapX, mapY, seriesConfig, dpr);
    this.drawSelectedPointMarker(ctx, pad, mapX, mapY, seriesConfig, dpr);
    ctx.restore();

    // 4. 繪製圖例 (Legend) 與即時數據看板
    this.drawLegendAndHud(ctx, pad, seriesConfig, currentTime, dpr);
  }

  getSeriesConfig() {
    const hasB = this.secondaryTrajectory && this.secondaryTrajectory.length >= 2;
    const prefixA = hasB ? "A." : "";

    if (this.type === "xt") {
      const lines = [];
      if (this.axisFilter === "all" || this.axisFilter === "x") {
        lines.push({ source: "primary", key: "meterX", name: `${prefixA}x`, color: this.colors.x });
        if (hasB) lines.push({ source: "secondary", key: "meterX", name: "B.x", color: "#c084fc", dash: [6, 4] });
      }
      if (this.axisFilter === "all" || this.axisFilter === "y") {
        lines.push({ source: "primary", key: "meterY", name: `${prefixA}y`, color: this.colors.y });
        if (hasB) lines.push({ source: "secondary", key: "meterY", name: "B.y", color: "#fb7185", dash: [6, 4] });
      }
      return { title: hasB ? "雙點位移 x-t / y-t" : "位移 x-t / y-t", unit: "m", lines };
    } else if (this.type === "vt") {
      const lines = [];
      if (this.axisFilter === "all" || this.axisFilter === "x") {
        lines.push({ source: "primary", key: "vx", name: `${prefixA}vx`, color: this.colors.x });
        if (hasB) lines.push({ source: "secondary", key: "vx", name: "B.vx", color: "#c084fc", dash: [6, 4] });
      }
      if (this.axisFilter === "all" || this.axisFilter === "y") {
        lines.push({ source: "primary", key: "vy", name: `${prefixA}vy`, color: this.colors.y });
        if (hasB) lines.push({ source: "secondary", key: "vy", name: "B.vy", color: "#fb7185", dash: [6, 4] });
      }
      if (this.axisFilter === "all" && !hasB) {
        lines.push({ source: "primary", key: "v", name: "|v|", color: this.colors.mag, dash: [4, 4] });
      }
      return { title: hasB ? "雙點速度 v-t" : "速度 v-t", unit: "m/s", lines };
    } else {
      const lines = [];
      if (this.axisFilter === "all" || this.axisFilter === "x") {
        lines.push({ source: "primary", key: "ax", name: `${prefixA}ax`, color: this.colors.x });
        if (hasB) lines.push({ source: "secondary", key: "ax", name: "B.ax", color: "#c084fc", dash: [6, 4] });
      }
      if (this.axisFilter === "all" || this.axisFilter === "y") {
        lines.push({ source: "primary", key: "ay", name: `${prefixA}ay`, color: this.colors.accY });
        if (hasB) lines.push({ source: "secondary", key: "ay", name: "B.ay", color: "#fb923c", dash: [6, 4] });
      }
      return { title: hasB ? "雙點加速度 a-t" : "加速度 a-t", unit: "m/s²", lines };
    }
  }

  calculateYRange(config) {
    const allVals = [];
    for (const line of config.lines) {
      const traj = line.source === "secondary" ? this.secondaryTrajectory : this.trajectory;
      for (const pt of traj) {
        const val = pt[line.key];
        if (val !== undefined && !isNaN(val) && isFinite(val)) {
          allVals.push(val);
        }
      }
    }

    if (allVals.length === 0) {
      return { minY: -1, maxY: 1 };
    }

    allVals.sort((a, b) => a - b);

    let minY = allVals[0];
    let maxY = allVals[allVals.length - 1];

    if (this.focusDataRange) {
      // 聚焦核心區間：在 v-t / a-t 時排除極端 2% 單幀碰撞尖峰，讓物理變化起伏佔滿視窗
      if (allVals.length >= 25 && (this.type === "at" || this.type === "vt")) {
        const pLow = allVals[Math.floor(allVals.length * 0.02)];
        const pHigh = allVals[Math.ceil(allVals.length * 0.98) - 1];
        if (pHigh - pLow > 0.05) {
          minY = pLow;
          maxY = pHigh;
        }
      }
    } else {
      // 完整模式：強制包含 0 基準線
      if (minY > 0) minY = 0;
      if (maxY < 0) maxY = 0;
    }

    const rawSpan = Math.max(maxY - minY, 0.1);
    const paddedSpan = rawSpan * 1.25;
    const center = (minY + maxY) / 2 + this.yPan;
    const zoomedHalfSpan = (paddedSpan / 2) / this.yZoom;

    return {
      minY: center - zoomedHalfSpan,
      maxY: center + zoomedHalfSpan
    };
  }

  drawGridAndAxes(ctx, pad, plotW, plotH, tMin, tMax, minY, maxY, mapX, mapY, unit, dpr) {
    ctx.save();
    ctx.lineWidth = 1 * dpr;
    ctx.strokeStyle = this.colors.grid;
    ctx.fillStyle = this.colors.text;
    ctx.font = `${11 * dpr}px -apple-system, sans-serif`;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    const ySpan = maxY - minY;
    const decimals = ySpan < 0.4 ? 3 : (ySpan < 4 ? 2 : 1);

    // 水平網格與 Y 刻度 (5 條)
    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
      const val = minY + (i / ySteps) * ySpan;
      const y = mapY(val);

      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();

      ctx.fillText(`${val.toFixed(decimals)} ${unit}`, pad.left - 6 * dpr, y);
    }

    // 0 基準水平線強調 (若 0 在視野內)
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

    const tSpan = tMax - tMin;
    const tDecimals = tSpan < 1 ? 2 : 1;
    const tSteps = 5;
    for (let i = 0; i <= tSteps; i++) {
      const t = tMin + (i / tSteps) * tSpan;
      const x = mapX(t);

      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, pad.top + plotH);
      ctx.stroke();

      ctx.fillText(`${t.toFixed(tDecimals)}s`, x, pad.top + plotH + 8 * dpr);
    }

    // 主座標軸外框
    ctx.strokeStyle = this.colors.axis;
    ctx.strokeRect(pad.left, pad.top, plotW, plotH);
    ctx.restore();
  }

  drawSeriesLine(ctx, line, mapX, mapY, currentTime, dpr) {
    const pts = line.source === "secondary" ? this.secondaryTrajectory : this.trajectory;
    if (!pts || pts.length < 2) return;

    ctx.save();
    ctx.lineWidth = 2.5 * dpr;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    if (this.drawMode === "full") {
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

      ctx.globalAlpha = 1.0;
      if (line.dash) ctx.setLineDash(line.dash.map(v => v * dpr));
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
          const interp = this.interpolate(currentTime, pts);
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

  drawCurrentTimeCursor(ctx, pad, plotH, currentTime, tMin, tMax, mapX, mapY, seriesConfig, dpr) {
    if (currentTime < tMin || currentTime > tMax) return;
    const curX = mapX(currentTime);

    ctx.save();
    ctx.strokeStyle = this.colors.cursor;
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.beginPath();
    ctx.moveTo(curX, pad.top);
    ctx.lineTo(curX, pad.top + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    const interpA = this.interpolate(currentTime, this.trajectory);
    const interpB = this.interpolate(currentTime, this.secondaryTrajectory);
    seriesConfig.lines.forEach(line => {
      const interp = line.source === "secondary" ? interpB : interpA;
      const val = interp ? interp[line.key] : undefined;
      if (val !== undefined) {
        const curY = mapY(val);

        ctx.beginPath();
        ctx.fillStyle = line.color;
        ctx.globalAlpha = 0.35;
        ctx.arc(curX, curY, 8 * dpr, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = 1.0;
        ctx.fillStyle = "#ffffff";
        ctx.beginPath();
        ctx.arc(curX, curY, 3.5 * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    ctx.restore();
  }

  drawFitCurve(ctx, fitResult, mapX, mapY, dpr) {
    if (!fitResult || !fitResult.curvePoints || fitResult.curvePoints.length < 2) return;
    ctx.save();
    ctx.strokeStyle = "#e879f9";
    ctx.lineWidth = 2.5 * dpr;
    ctx.setLineDash([7 * dpr, 4 * dpr]);
    ctx.shadowColor = "rgba(232, 121, 249, 0.45)";
    ctx.shadowBlur = 6 * dpr;
    ctx.beginPath();
    fitResult.curvePoints.forEach((pt, idx) => {
      const x = mapX(pt.t);
      const y = mapY(pt.val);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.restore();
  }

  drawSelectedPointMarker(ctx, pad, mapX, mapY, seriesConfig, dpr) {
    const selTraj = this.selectedTarget === "B" && this.secondaryTrajectory.length > 0
      ? this.secondaryTrajectory
      : this.trajectory;
    if (this.selectedIndex === null || !selTraj[this.selectedIndex]) return;
    const pt = selTraj[this.selectedIndex];
    const sx = mapX(pt.t);
    const activeSource = this.selectedTarget === "B" ? "secondary" : "primary";

    ctx.save();
    seriesConfig.lines.forEach(line => {
      if (line.source !== activeSource) return;
      const val = pt[line.key];
      if (val === undefined) return;
      const sy = mapY(val);

      ctx.strokeStyle = "#facc15";
      ctx.fillStyle = "rgba(250, 204, 21, 0.28)";
      ctx.lineWidth = 2.5 * dpr;
      ctx.beginPath();
      ctx.arc(sx, sy, 8 * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#fef08a";
      ctx.font = `bold ${10 * dpr}px monospace`;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(`#${this.selectedIndex}: ${val.toFixed(2)}`, sx + 8 * dpr, sy - 6 * dpr);
    });
    ctx.restore();
  }

  drawLegendAndHud(ctx, pad, config, currentTime, dpr) {
    ctx.save();
    ctx.font = `bold ${12 * dpr}px -apple-system, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    ctx.fillStyle = this.colors.textHighlight;
    ctx.fillText(config.title, pad.left, pad.top - 16 * dpr);

    const interpA = this.interpolate(currentTime, this.trajectory);
    const interpB = this.interpolate(currentTime, this.secondaryTrajectory);

    let offsetX = pad.left + ctx.measureText(config.title).width + 14 * dpr;
    ctx.font = `${10.5 * dpr}px monospace`;
    const maxW = this.canvas.width - pad.right;

    config.lines.forEach(line => {
      const interp = line.source === "secondary" ? interpB : interpA;
      let label = line.name;
      if (interp && interp[line.key] !== undefined) {
        label += `:${interp[line.key].toFixed(2)}`;
      }
      const needed = 12 * dpr + ctx.measureText(label).width + 12 * dpr;
      if (offsetX + needed > maxW) return;

      ctx.fillStyle = line.color;
      ctx.fillRect(offsetX, pad.top - 20 * dpr, 8 * dpr, 8 * dpr);

      ctx.fillStyle = this.colors.text;
      ctx.fillText(label, offsetX + 11 * dpr, pad.top - 16 * dpr);
      offsetX += needed;
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
