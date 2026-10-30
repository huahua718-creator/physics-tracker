/**
 * vector-drawer.js
 * 大屏物理向量與殘影繪製引擎 (Canvas Overlay)
 * 職責：
 * 1. 座標轉換 (影片原生解析度 -> 螢幕顯示 Canvas 尺寸)
 * 2. 運動軌跡殘影點列 (Strobe Effect) 與漸變消褪
 * 3. 速度向量 (v 綠色箭頭) 與數值標註
 * 4. 加速度向量 (a 紅色箭頭) 與數值標註
 */

export class VectorDrawer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");

    // 向量繪製縮放因子 (公尺/秒 -> 螢幕像素長度)
    this.vScale = options.vScale || 25; // 1 m/s = 25px
    this.aScale = options.aScale || 8;  // 1 m/s^2 = 8px

    // 圖層顯示開關
    this.showGhost = options.showGhost !== undefined ? options.showGhost : true;
    this.showVelocity = options.showVelocity !== undefined ? options.showVelocity : true;
    this.showAcceleration = options.showAcceleration !== undefined ? options.showAcceleration : true;
    this.showValues = options.showValues !== undefined ? options.showValues : true;

    // 殘影設定
    this.strobeStep = options.strobeStep || 3; // 每隔幾幀保留一顆殘影
    this.ghostMaxCount = options.ghostMaxCount || 40; // 最大殘影數量
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
   * 繪製向量箭頭 (含箭頭錐形與文字)
   */
  drawArrow(fromX, fromY, vecX, vecY, options = {}) {
    const color = options.color || "#00e676";
    const lineWidth = options.lineWidth || 3.5;
    const arrowLen = options.arrowLen || 12;
    const label = options.label || "";

    const toX = fromX + vecX;
    const toY = fromY + vecY;
    const mag = Math.hypot(vecX, vecY);

    if (mag < 2) return; // 向量極小時略過

    const angle = Math.atan2(vecY, vecX);
    const ctx = this.ctx;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";

    // 陰影增加高對比可讀性
    ctx.shadowColor = "rgba(0, 0, 0, 0.7)";
    ctx.shadowBlur = 6;

    // 繪製箭桿
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();

    // 繪製箭頭三角錐
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(
      toX - arrowLen * Math.cos(angle - Math.PI / 6),
      toY - arrowLen * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      toX - arrowLen * Math.cos(angle + Math.PI / 6),
      toY - arrowLen * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();

    // 繪製向量標籤文字
    if (label && this.showValues) {
      ctx.font = "bold 13px Inter, -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const textOffsetDist = 18;
      const textX = toX + textOffsetDist * Math.cos(angle);
      const textY = toY + textOffsetDist * Math.sin(angle);

      // 標籤背景泡泡
      const textMetrics = ctx.measureText(label);
      const padding = 5;
      ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.roundRect(
        textX - textMetrics.width / 2 - padding,
        textY - 9,
        textMetrics.width + padding * 2,
        18,
        4
      );
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, textX, textY);
    }

    ctx.restore();
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

    // 3. 繪製速度向量 v (綠色)
    if (this.showVelocity) {
      // 物理世界: vx, vy (m/s) -> 乘上比例 scale
      // 注意: vy 正值代表向上，在螢幕坐標需要取負號
      const vxScreen = currentPoint.vx * this.vScale * params.scale;
      const vyScreen = -currentPoint.vy * this.vScale * params.scale;
      const vMag = currentPoint.v.toFixed(2);

      this.drawArrow(center.x, center.y, vxScreen, vyScreen, {
        color: "#10b981", // 鮮明綠
        lineWidth: 3.5,
        arrowLen: 14,
        label: `v: ${vMag} m/s`
      });
    }

    // 4. 繪製加速度向量 a (紅色)
    if (this.showAcceleration) {
      // 物理世界: ax, ay (m/s^2) -> 向上為正，螢幕向下為負
      const axScreen = currentPoint.ax * this.aScale * params.scale;
      const ayScreen = -currentPoint.ay * this.aScale * params.scale;
      const aMag = currentPoint.a.toFixed(1);

      this.drawArrow(center.x, center.y, axScreen, ayScreen, {
        color: "#ef4444", // 鮮明紅
        lineWidth: 3.5,
        arrowLen: 14,
        label: `a: ${aMag} m/s²`
      });
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
      const alpha = Math.max(0.2, (i + 1) / n);
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
