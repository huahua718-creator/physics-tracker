/**
 * video-tracker.js
 * 離線非即時逐幀（Non-realtime Step Frame）影像分析管線
 * 包含：色彩追蹤、動態差分、質心辨識、尺標校準與進度回報
 */

export class VideoTracker {
  constructor(options = {}) {
    this.fps = options.fps || 120; // 預設 120 FPS
    this.targetColor = options.targetColor || { r: 255, g: 80, b: 0 }; // 追蹤目標顏色 (RGB)
    this.colorTolerance = options.colorTolerance || 60; // 容許色差
    this.roi = options.roi || null; // 感興趣區域 {x, y, width, height}
    this.scalePoints = []; // 尺標標定兩點 [{x, y}, {x, y}]
    this.realWorldLength = 1.0; // 尺標對應實際公尺數
    this.isAnalyzing = false;
    this.cancelRequested = false;

    // 離線渲染專用 Canvas
    this.canvas = document.createElement("canvas");
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
  }

  /**
   * 設定分析 FPS (例如 60, 120, 240)
   */
  setFPS(fps) {
    this.fps = Math.max(1, Math.min(480, fps));
  }

  /**
   * 設定目標追蹤顏色
   */
  setTargetColor(r, g, b, tolerance = 60) {
    this.targetColor = { r, g, b };
    this.colorTolerance = tolerance;
  }

  /**
   * 設定 ROI (感興趣區域)
   */
  setROI(x, y, width, height) {
    if (width > 5 && height > 5) {
      this.roi = { x, y, width, height };
    } else {
      this.roi = null;
    }
  }

  /**
   * 等待 video 跳轉至指定時間點並完成繪製
   */
  seekTo(video, targetTime) {
    return new Promise((resolve) => {
      const onSeeked = () => {
        video.removeEventListener("seeked", onSeeked);
        resolve();
      };
      video.addEventListener("seeked", onSeeked, { once: true });
      video.currentTime = targetTime;
    });
  }

  /**
   * 像素顏色距離 (歐式空間加權)
   */
  colorDistance(r1, g1, b1, r2, g2, b2) {
    const dr = r1 - r2;
    const dg = g1 - g2;
    const db = b1 - b2;
    // 人眼感知加權 (Redmean metric)
    const rmean = (r1 + r2) / 2;
    return Math.sqrt(
      (2 + rmean / 256) * dr * dr +
      4 * dg * dg +
      (2 + (255 - rmean) / 256) * db * db
    );
  }

  /**
   * 於指定影格影像內進行質心辨識 (Weighted Centroid)
   */
  findCentroid(imageData, roi) {
    const data = imageData.data;
    const width = imageData.width;
    const height = imageData.height;

    const startX = roi ? Math.max(0, Math.floor(roi.x)) : 0;
    const startY = roi ? Math.max(0, Math.floor(roi.y)) : 0;
    const endX = roi ? Math.min(width, Math.floor(roi.x + roi.width)) : width;
    const endY = roi ? Math.min(height, Math.floor(roi.y + roi.height)) : height;

    let totalWeight = 0;
    let sumX = 0;
    let sumY = 0;

    const tr = this.targetColor.r;
    const tg = this.targetColor.g;
    const tb = this.targetColor.b;
    const tol = this.colorTolerance;

    for (let y = startY; y < endY; y += 2) { // 步長2提升離線分析速度
      const rowOffset = y * width * 4;
      for (let x = startX; x < endX; x += 2) {
        const idx = rowOffset + x * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        const dist = this.colorDistance(r, g, b, tr, tg, tb);
        if (dist <= tol) {
          // 距離越近權重越高
          const weight = (tol - dist + 1);
          sumX += x * weight;
          sumY += y * weight;
          totalWeight += weight;
        }
      }
    }

    if (totalWeight > 10) {
      return {
        x: sumX / totalWeight,
        y: sumY / totalWeight,
        confidence: Math.min(1.0, totalWeight / 1500)
      };
    }

    return null;
  }

  /**
   * 核心：逐幀提取分析 (Non-realtime Step Frame Extraction)
   * @param {HTMLVideoElement} video 欲分析的影片
   * @param {Object} options { startTime, endTime, onProgress }
   */
  async analyzeVideo(video, options = {}) {
    if (this.isAnalyzing) throw new Error("已有分析作業進行中");
    this.isAnalyzing = true;
    this.cancelRequested = false;

    const duration = video.duration || 5;
    const startTime = Math.max(0, options.startTime || 0);
    const endTime = Math.min(duration, options.endTime || duration);
    const onProgress = options.onProgress || (() => {});

    // 初始化離線繪圖畫布尺寸
    this.canvas.width = video.videoWidth || 1280;
    this.canvas.height = video.videoHeight || 720;

    const dt = 1 / this.fps;
    const totalFrames = Math.max(1, Math.floor((endTime - startTime) / dt));
    const trajectory = [];

    let lastKnownPos = null;

    try {
      video.pause();

      for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
        if (this.cancelRequested) {
          console.warn("分析已由使用者中止");
          break;
        }

        const currentTime = startTime + frameIdx * dt;
        await this.seekTo(video, currentTime);

        // 將當前影格繪製至離線畫布
        this.ctx.drawImage(video, 0, 0, this.canvas.width, this.canvas.height);
        const imgData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);

        // 若已有上一次位置，自適應微調 ROI 追蹤窗口
        let currentROI = this.roi;
        if (!currentROI && lastKnownPos) {
          const searchRadius = 90;
          currentROI = {
            x: lastKnownPos.x - searchRadius,
            y: lastKnownPos.y - searchRadius,
            width: searchRadius * 2,
            height: searchRadius * 2
          };
        }

        const point = this.findCentroid(imgData, currentROI);

        if (point) {
          lastKnownPos = { x: point.x, y: point.y };
          trajectory.push({
            t: currentTime,
            x: point.x,
            y: point.y,
            found: true
          });
        } else if (lastKnownPos) {
          // 影格未偵測到時暫存上一點 (或標記遺失)
          trajectory.push({
            t: currentTime,
            x: lastKnownPos.x,
            y: lastKnownPos.y,
            found: false
          });
        }

        const percent = Math.min(100, Math.round(((frameIdx + 1) / totalFrames) * 100));
        onProgress({
          percent,
          currentFrame: frameIdx + 1,
          totalFrames,
          currentTime,
          latestPoint: point || lastKnownPos
        });
      }
    } finally {
      this.isAnalyzing = false;
    }

    return trajectory;
  }

  cancel() {
    this.cancelRequested = true;
  }

  /**
   * 產生示範物理慢動作影片 (拋體與彈跳運動模擬，自帶 1 公尺標尺)
   * 方便使用者在沒有現成 120fps/240fps 檔案時一鍵產生測試
   * @returns {Blob} 產生的 WebM 影片 Blob
   */
  static generateDemoVideo(duration = 2.5, fps = 60) {
    return new Promise((resolve) => {
      const width = 1280;
      const height = 720;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");

      const stream = canvas.captureStream(fps);
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
          ? "video/webm;codecs=vp9"
          : "video/webm"
      });

      const chunks = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: "video/webm" });
        resolve(blob);
      };

      mediaRecorder.start();

      // 物理常數模擬 (斜拋 + 重力 + 地面彈跳)
      const g = 9.8; // m/s^2
      const scale = 250; // 250 px = 1 m
      let x = 150; // px
      let y = 520; // px (地面在 600)
      let vx = 3.2 * scale; // 水平速度
      let vy = -6.5 * scale; // 向上初速
      const dt = 1 / fps;
      const totalFrames = Math.floor(duration * fps);
      let currentFrame = 0;

      const drawFrame = () => {
        if (currentFrame >= totalFrames) {
          mediaRecorder.stop();
          return;
        }

        // 數值更新 (歐拉積分)
        vy += g * scale * dt;
        x += vx * dt;
        y += vy * dt;

        // 地面碰撞
        if (y > 580) {
          y = 580;
          vy = -vy * 0.82; // 恢復係數
        }

        // 繪製背景 (物理實驗室深色格線背景)
        ctx.fillStyle = "#121824";
        ctx.fillRect(0, 0, width, height);

        // 繪製格線
        ctx.strokeStyle = "rgba(255, 255, 255, 0.07)";
        ctx.lineWidth = 1;
        for (let gx = 0; gx < width; gx += 50) {
          ctx.beginPath();
          ctx.moveTo(gx, 0);
          ctx.lineTo(gx, height);
          ctx.stroke();
        }
        for (let gy = 0; gy < height; gy += 50) {
          ctx.beginPath();
          ctx.moveTo(0, gy);
          ctx.lineTo(width, gy);
          ctx.stroke();
        }

        // 繪製 1.0 公尺參考標尺 (250px)
        const rulerX = 120;
        const rulerY = 640;
        ctx.strokeStyle = "#38bdf8";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(rulerX, rulerY);
        ctx.lineTo(rulerX + scale, rulerY);
        ctx.stroke();

        // 標尺兩端垂直端線
        ctx.beginPath();
        ctx.moveTo(rulerX, rulerY - 10);
        ctx.lineTo(rulerX, rulerY + 10);
        ctx.moveTo(rulerX + scale, rulerY - 10);
        ctx.lineTo(rulerX + scale, rulerY + 10);
        ctx.stroke();

        ctx.fillStyle = "#38bdf8";
        ctx.font = "bold 16px sans-serif";
        ctx.fillText("標準尺標: 1.0 m (250 px)", rulerX + 30, rulerY - 14);

        // 繪製地面
        ctx.fillStyle = "#334155";
        ctx.fillRect(0, 600, width, 120);
        ctx.fillStyle = "#64748b";
        ctx.font = "14px sans-serif";
        ctx.fillText("Ground Level (y = 0)", 20, 625);

        // 繪製鮮豔紅色測試球 (RGB 255, 60, 40)
        ctx.fillStyle = "#ff3b30";
        ctx.beginPath();
        ctx.arc(x, y, 16, 0, Math.PI * 2);
        ctx.fill();

        // 球體高光
        ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
        ctx.beginPath();
        ctx.arc(x - 5, y - 5, 5, 0, Math.PI * 2);
        ctx.fill();

        currentFrame++;
        requestAnimationFrame(drawFrame);
      };

      requestAnimationFrame(drawFrame);
    });
  }
}
