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

    // 使用者點選的特定影像點索引
    this.selectedIndex = null;
  }

  setSelectedIndex(index) {
    this.selectedIndex = (index !== null && index !== undefined && index >= 0) ? index : null;
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
   * 依據螢幕點擊座標 (clientX, clientY) 尋找距離最近的影片軌跡點
   */
  findNearestPoint(video, trajectory, clientX, clientY, maxDistPx = 38) {
    if (!video || !trajectory || trajectory.length === 0) return null;
    this.syncSizeWithVideo(video);

    const rect = this.canvas.getBoundingClientRect();
    const clickX = clientX - rect.left;
    const clickY = clientY - rect.top;
    const params = this.getVideoRenderParams(video);

    let bestIndex = -1;
    let bestDist = Infinity;

    for (let i = 0; i < trajectory.length; i++) {
      const coords = this.toCanvasCoords(trajectory[i].x, trajectory[i].y, params);
      const dist = Math.hypot(coords.x - clickX, coords.y - clickY);
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = i;
      }
    }

    if (bestIndex >= 0 && bestDist <= maxDistPx) {
      return { index: bestIndex, point: trajectory[bestIndex], dist: bestDist };
    }
    return null;
  }

  /**
   * 核心渲染函式
   * @param {HTMLVideoElement} video 底層影片元素
   * @param {Array} trajectory 全部物理軌跡陣列
   * @param {Object} currentPoint 當前時間內插之物理點
   */
  render(video, trajectory, currentPoint) {
    this.syncSizeWithVideo(video);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    if (!video || !trajectory || trajectory.length === 0 || !currentPoint) return;

    const params = this.getVideoRenderParams(video);

    // 1. 繪製殘影軌跡 (Strobe Effect)
    if (this.showGhost) {
      this.renderGhostStrobe(trajectory, currentPoint, params);
    }

    // 當前質心投影座標
    const center = this.toCanvasCoords(currentPoint.x, currentPoint.y, params);

    // 2. 繪製當前質心定位標記 (十字瞄準圈)
    ctx.save();
    ctx.strokeStyle = "#ffffff";
    ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(center.x, center.y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 瞄準外圈
    ctx.beginPath();
    ctx.arc(center.x, center.y, 16, 0, Math.PI * 2);
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.restore();

    // 3. 若有選中的影像點，繪製醒目的金色選取標記與座標氣泡
    if (this.selectedIndex !== null && trajectory[this.selectedIndex]) {
      const selPt = trajectory[this.selectedIndex];
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

      const label = `#${this.selectedIndex} (${selPt.t.toFixed(2)}s, y:${selPt.meterY.toFixed(2)}m)`;
      ctx.font = "bold 12px -apple-system, sans-serif";
      const metrics = ctx.measureText(label);
      const boxX = Math.min(this.canvas.width - metrics.width - 16, selCoords.x + 16);
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
  renderGhostStrobe(trajectory, currentPoint, params) {
    const ctx = this.ctx;
    ctx.save();

    // 篩選出當前時間之前的軌跡點
    const pastPoints = trajectory.filter(p => p.t <= currentPoint.t);
    const totalPast = pastPoints.length;

    // 完整軌跡淡色預覽點 (方便滑鼠隨時點擊影片上的任意殘影點)
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

    // 連續軌跡平滑細線
    if (totalPast > 1) {
      ctx.beginPath();
      ctx.strokeStyle = "rgba(56, 189, 248, 0.4)";
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);

      for (let i = 0; i < totalPast; i++) {
        const pt = this.toCanvasCoords(pastPoints[i].x, pastPoints[i].y, params);
        if (i === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      }
      ctx.stroke();
    }

    // 殘影光點 (每隔 strobeStep 抽樣)
    const sampled = [];
    for (let i = 0; i < totalPast; i += this.strobeStep) {
      sampled.push(pastPoints[i]);
    }

    const n = sampled.length;
    for (let i = 0; i < n; i++) {
      const pt = sampled[i];
      const coords = this.toCanvasCoords(pt.x, pt.y, params);

      // 透明度漸變 (越接近當前時間越清晰)
      const alpha = Math.max(0.25, (i + 1) / n);
      const radius = 5 + (alpha * 3);

      ctx.fillStyle = `rgba(56, 189, 248, ${alpha * 0.8})`;
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
