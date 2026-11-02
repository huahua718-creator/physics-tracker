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
   * 等待 video 跳轉至指定時間點並完成繪製 (含安全超時)
   */
  seekTo(video, targetTime) {
    return new Promise((resolve) => {
      let resolved = false;
      const cleanup = () => {
        if (!resolved) {
          resolved = true;
          video.removeEventListener("seeked", onSeeked);
          resolve();
        }
      };
      const onSeeked = () => cleanup();
      video.addEventListener("seeked", onSeeked, { once: true });
      video.currentTime = Math.min(video.duration || 999, Math.max(0, targetTime));
      // 容錯防禦：若 250ms 內未觸發 seeked 則強制繼續，避免卡死
      setTimeout(cleanup, 250);
    });
  }

  /**
   * 像素顏色距離 (結合人眼加權與飽和度特徵)
   */
  colorDistance(r1, g1, b1, r2, g2, b2) {
    const dr = r1 - r2;
    const dg = g1 - g2;
    const db = b1 - b2;
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
    // 適度放寬容許值確保運動模糊或微小光影變化依然能穩定咬住目標
    const tol = Math.max(75, this.colorTolerance);

    for (let y = startY; y < endY; y += 2) { // 步長2提升離線分析速度
      const rowOffset = y * width * 4;
      for (let x = startX; x < endX; x += 2) {
        const idx = rowOffset + x * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        const dist = this.colorDistance(r, g, b, tr, tg, tb);
        if (dist <= tol) {
          const weight = (tol - dist + 1);
          sumX += x * weight;
          sumY += y * weight;
          totalWeight += weight;
        }
      }
    }

    if (totalWeight > 8) {
      return {
        x: sumX / totalWeight,
        y: sumY / totalWeight,
        confidence: Math.min(1.0, totalWeight / 1200)
      };
    }

    return null;
  }

  /**
   * 核心：逐幀提取分析 (Non-realtime Step Frame Extraction)
   * 具備：局部預測搜尋 + 全局自動重捕獲 (Global Fallback Re-acquisition)
   */
  async analyzeVideo(video, options = {}) {
    if (this.isAnalyzing) throw new Error("已有分析作業進行中");
    this.isAnalyzing = true;
    this.cancelRequested = false;

    const duration = video.duration || 5;
    const startTime = Math.max(0, options.startTime || 0);
    const endTime = Math.min(duration, options.endTime || duration);
    const onProgress = options.onProgress || (() => {});

    this.canvas.width = video.videoWidth || 1280;
    this.canvas.height = video.videoHeight || 720;

    const dt = 1 / this.fps;
    const totalFrames = Math.max(1, Math.floor((endTime - startTime) / dt));
    const trajectory = [];

    let lastKnownPos = null;
    let lastVelocity = { vx: 0, vy: 0 };

    try {
      video.pause();

      for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
        if (this.cancelRequested) {
          console.warn("分析已由使用者中止");
          break;
        }

        const currentTime = startTime + frameIdx * dt;
        await this.seekTo(video, currentTime);

        this.ctx.drawImage(video, 0, 0, this.canvas.width, this.canvas.height);
        const imgData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);

        // 1. 若有上一影格座標，使用速度預測中心建立局部搜尋窗口 (ROI)
        let point = null;
        if (this.roi) {
          point = this.findCentroid(imgData, this.roi);
        } else if (lastKnownPos) {
          const searchRadius = 140; // 放寬搜尋半徑，適應彈跳大速度
          const predX = lastKnownPos.x + lastVelocity.vx * dt;
          const predY = lastKnownPos.y + lastVelocity.vy * dt;
          const localROI = {
            x: predX - searchRadius,
            y: predY - searchRadius,
            width: searchRadius * 2,
            height: searchRadius * 2
          };
          point = this.findCentroid(imgData, localROI);
        }

        // 2. 關鍵保證：若局部未找到，立即切換為全畫面全域搜尋 (Global Fallback)
        // 徹底解決因彈跳或高速運動導致超出局部窗口而永久丟失標記的問題！
        if (!point) {
          point = this.findCentroid(imgData, null);
        }

        if (point) {
          if (lastKnownPos) {
            lastVelocity = {
              vx: (point.x - lastKnownPos.x) / dt,
              vy: (point.y - lastKnownPos.y) / dt
            };
          }
          lastKnownPos = { x: point.x, y: point.y };
          trajectory.push({
            t: currentTime,
            x: point.x,
            y: point.y,
            found: true
          });
        } else if (lastKnownPos) {
          // 若畫面短暫丟失，使用上一位置保持連貫
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

      // 物理常數模擬 (斜拋 + 重力 + 地面彈跳，確保軌跡全程 100% 完整保留在畫面內)
      const g = 9.8; // m/s^2
      const scale = 250; // 250 px = 1 m
      let x = 120; // 起始 x
      let y = 480; // 起始 y
      let vx = 1.7 * scale; // 水平初速 ~425 px/s (2.5秒內橫跨 1060px，不超出 1280 邊界)
      let vy = -4.1 * scale; // 向上初速 ~-1025 px/s (最高點約在 y = 265px，絕不出上邊界)
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

        // 地面彈跳碰撞 (地面在 y = 580)
        if (y > 580) {
          y = 580;
          vy = -Math.abs(vy) * 0.78; // 彈性碰撞係數
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
