/**
 * vector-drawer.js
 * 大屏物理軌跡與殘影繪製引擎 (Canvas Overlay)
 * 職責：
 * 1. 座標轉換 (影片原生解析度 -> 螢幕顯示 Canvas 尺寸)
 * 2. 運動軌跡殘影點列 (Strobe Effect) 與漸變消褪
 * 3. 支援點擊影像點高亮選取，與圖表/表格雙向連動
 */

export class VectorDrawer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");

    // 圖層顯示開關 (已移除速度與加速度箭頭，維持大屏投影畫面乾淨)
    this.showGhost = options.showGhost !== undefined ? options.showGhost : true;
    this.showVelocity = false;
    this.showAcceleration = false;
    this.showValues = options.showValues !== undefined ? options.showValues : true;

    // 殘影設定
    this.strobeStep = options.strobeStep || 3; // 每隔幾幀保留一顆殘影
    this.ghostMaxCount = options.ghostMaxCount || 40; // 最大殘影數量

    // 使用者點選的特定影像點索引與所屬目標 ("A" | "B")
    this.selectedIndex = null;
    this.selectedTarget = "A";
  }

  setSelectedIndex(index, target = "A") {
    this.selectedIndex = (index !== null && index !== undefined && index >= 0) ? index : null;
    this.selectedTarget = target === "B" ? "B" : "A";
  }

  /**
   * 同步畫布尺寸至目標 Video 或容器
   */
  syncSizeWithVideo(video) {
    if (!video || !video.videoWidth) return;

    const rect = video.getBoundingClientRect();
    if (this.canvas.width !== rect.width || this.canvas.height !== rect.height) {
      this.canvas.width = rect.width;
      this.canvas.height = rect.height;
    }
  }

  /**
   * 取得影片原生像素至當前 Canvas 顯示像素的縮放比例與邊距 (處理 contain 比例)
   */
  getVideoRenderParams(video) {
    const videoWidth = video.videoWidth || 1280;
    const videoHeight = video.videoHeight || 720;
    const canvasWidth = this.canvas.width;
    const canvasHeight = this.canvas.height;

    const scale = Math.min(canvasWidth / videoWidth, canvasHeight / videoHeight);
    const offsetX = (canvasWidth - videoWidth * scale) / 2;
    const offsetY = (canvasHeight - videoHeight * scale) / 2;

    return { scale, offsetX, offsetY, videoWidth, videoHeight };
  }

  /**
   * 將影片像素座標轉為 Canvas 像素座標
   */
  toCanvasCoords(x, y, params) {
    return {
      x: params.offsetX + x * params.scale,
      y: params.offsetY + y * params.scale
    };
  }

  /**
   * 依據螢幕點擊座標 (clientX, clientY) 尋找距離最近的影片軌跡點 (支援單點或雙點 A/B)
   */
  findNearestPoint(video, trajectory, clientX, clientY, maxDistPx = 38, secondaryTrajectory = null) {
    if (!video || ((!trajectory || trajectory.length === 0) && (!secondaryTrajectory || secondaryTrajectory.length === 0))) {
      return null;
    }
    this.syncSizeWithVideo(video);

    const rect = this.canvas.getBoundingClientRect();
    const clickX = clientX - rect.left;
    const clickY = clientY - rect.top;
    const params = this.getVideoRenderParams(video);

    let bestTarget = "A";
    let bestIndex = -1;
    let bestPoint = null;
    let bestDist = Infinity;

    const searchSeries = (traj, label) => {
      if (!traj) return;
      for (let i = 0; i < traj.length; i++) {
        const coords = this.toCanvasCoords(traj[i].x, traj[i].y, params);
        const dist = Math.hypot(coords.x - clickX, coords.y - clickY);
        if (dist < bestDist) {
          bestDist = dist;
          bestIndex = i;
          bestTarget = label;
          bestPoint = traj[i];
        }
      }
    };

    searchSeries(trajectory, "A");
    searchSeries(secondaryTrajectory, "B");

    if (bestIndex >= 0 && bestDist <= maxDistPx) {
      return { target: bestTarget, index: bestIndex, point: bestPoint, dist: bestDist };
    }
    return null;
  }

  /**
   * 核心渲染函式 (支援雙點比較模式：可選傳入 targetCtx 供離屏匯出影片直接繪製)
   */
  render(video, trajectory, currentPoint, secondaryTrajectory = null, secondaryCurrentPoint = null, targetCtx = null, customParams = null) {
    if (!targetCtx) {
      this.syncSizeWithVideo(video);
    }
    const ctx = targetCtx || this.ctx;
    const canvasW = ctx.canvas.width;
    const canvasH = ctx.canvas.height;
    if (!targetCtx) {
      ctx.clearRect(0, 0, canvasW, canvasH);
    }

    const hasA = !!(trajectory && trajectory.length > 0 && currentPoint);
    const hasB = !!(secondaryTrajectory && secondaryTrajectory.length > 0 && secondaryCurrentPoint);
    if (!video || (!hasA && !hasB)) return;

    const params = customParams || this.getVideoRenderParams(video);
    const isDual = hasA && hasB;

    // 1. 繪製殘影軌跡 (Strobe Effect)
    if (this.showGhost) {
      if (hasA) {
        this.renderGhostStrobe(ctx, trajectory, currentPoint, params, {
          fillRgb: "56, 189, 248",
          lineRgba: "rgba(56, 189, 248, 0.4)"
        });
      }
      if (hasB) {
        this.renderGhostStrobe(ctx, secondaryTrajectory, secondaryCurrentPoint, params, {
          fillRgb: "251, 113, 133",
          lineRgba: "rgba(251, 113, 133, 0.45)"
        });
      }
    }

    // 2. 若同時存在雙點，繪製 A-B 間距虛線輔助比較
    if (isDual) {
      const cA = this.toCanvasCoords(currentPoint.x, currentPoint.y, params);
      const cB = this.toCanvasCoords(secondaryCurrentPoint.x, secondaryCurrentPoint.y, params);
      ctx.save();
      ctx.strokeStyle = "rgba(250, 204, 21, 0.55)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(cA.x, cA.y);
      ctx.lineTo(cB.x, cB.y);
      ctx.stroke();
      ctx.restore();
    }

    const drawCrosshair = (pt, ringColor, tagLabel) => {
      const center = this.toCanvasCoords(pt.x, pt.y, params);
      ctx.save();
      ctx.strokeStyle = ringColor;
      ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(center.x, center.y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(center.x, center.y, 16, 0, Math.PI * 2);
      ctx.setLineDash([4, 4]);
      ctx.stroke();

      if (tagLabel) {
        ctx.setLineDash([]);
        ctx.font = "bold 12px -apple-system, sans-serif";
        ctx.fillStyle = ringColor;
        ctx.fillText(tagLabel, center.x + 18, center.y - 12);
      }
      ctx.restore();
    };

    if (hasA) drawCrosshair(currentPoint, isDual ? "#38bdf8" : "#ffffff", isDual ? "A" : "");
    if (hasB) drawCrosshair(secondaryCurrentPoint, "#fb7185", "B");

    // 3. 若有選中的影像點，繪製醒目的金色選取標記與座標氣泡
    const activeTraj = this.selectedTarget === "B" && hasB ? secondaryTrajectory : trajectory;
    if (this.selectedIndex !== null && activeTraj && activeTraj[this.selectedIndex]) {
      const selPt = activeTraj[this.selectedIndex];
      const selCoords = this.toCanvasCoords(selPt.x, selPt.y, params);

      ctx.save();
      ctx.fillStyle = "rgba(250, 204, 21, 0.3)";
      ctx.beginPath();
      ctx.arc(selCoords.x, selCoords.y, 18, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = "#facc15";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(selCoords.x, selCoords.y, 11, 0, Math.PI * 2);
      ctx.stroke();

      const tagPrefix = isDual ? `${this.selectedTarget}#` : "#";
      const label = `${tagPrefix}${this.selectedIndex} (${selPt.t.toFixed(2)}s, y:${selPt.meterY.toFixed(2)}m)`;
      ctx.font = "bold 12px -apple-system, sans-serif";
      const metrics = ctx.measureText(label);
      const boxX = Math.min(canvasW - metrics.width - 16, selCoords.x + 16);
      const boxY = Math.max(24, selCoords.y - 12);

      ctx.fillStyle = "rgba(15, 23, 42, 0.9)";
      ctx.strokeStyle = "#facc15";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(boxX, boxY - 11, metrics.width + 12, 22, 6);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#fef08a";
      ctx.textBaseline = "middle";
      ctx.fillText(label, boxX + 6, boxY);
      ctx.restore();
    }
  }

  /**
   * 繪製運動殘影頻閃效果 (Strobe Effect)
   */
  renderGhostStrobe(ctx, trajectory, currentPoint, params, style = {}) {
    const fillRgb = style.fillRgb || "56, 189, 248";
    const lineRgba = style.lineRgba || "rgba(56, 189, 248, 0.4)";
    ctx.save();

    const pastPoints = trajectory.filter(p => p.t <= currentPoint.t);
    const totalPast = pastPoints.length;

    for (let i = 0; i < trajectory.length; i += this.strobeStep) {
      const pt = trajectory[i];
      if (pt.t > currentPoint.t) {
        const coords = this.toCanvasCoords(pt.x, pt.y, params);
        ctx.fillStyle = "rgba(148, 163, 184, 0.25)";
        ctx.beginPath();
        ctx.arc(coords.x, coords.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (totalPast > 1) {
      ctx.beginPath();
      ctx.strokeStyle = lineRgba;
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);

      for (let i = 0; i < totalPast; i++) {
        const pt = this.toCanvasCoords(pastPoints[i].x, pastPoints[i].y, params);
        if (i === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const sampled = [];
    for (let i = 0; i < totalPast; i += this.strobeStep) {
      sampled.push(pastPoints[i]);
    }

    const n = sampled.length;
    for (let i = 0; i < n; i++) {
      const pt = sampled[i];
      const coords = this.toCanvasCoords(pt.x, pt.y, params);
      const alpha = Math.max(0.25, (i + 1) / n);
      const radius = 5 + (alpha * 3);

      ctx.fillStyle = `rgba(${fillRgb}, ${alpha * 0.8})`;
      ctx.beginPath();
      ctx.arc(coords.x, coords.y, radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.9})`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.restore();
  }
}
