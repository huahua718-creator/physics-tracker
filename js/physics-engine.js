/**
 * physics-engine.js
 * 專為高幀率慢動作影片軌跡設計之物理運算引擎
 * 具備：尺標校準、Savitzky-Golay 濾波平滑化、中心差分求導 (v, a) 與時間內插功能
 */

export class PhysicsEngine {
  constructor(options = {}) {
    // 預設比例尺: 1 像素 = 0.0025 公尺 (可透過校準更新)
    this.pixelToMeter = options.pixelToMeter || 0.0025;
    this.origin = options.origin || { x: 0, y: 0 }; // 物理原點 (像素座標)
    this.yAxisUp = options.yAxisUp !== undefined ? options.yAxisUp : true; // 預設向上為正 (符合高中物理習慣)
  }

  /**
   * 設定尺標比例
   * @param {number} pixelDistance 畫布上的像素距離
   * @param {number} realDistanceMeters 現實世界長度 (公尺)
   */
  setScale(pixelDistance, realDistanceMeters) {
    if (pixelDistance <= 0 || realDistanceMeters <= 0) {
      throw new Error("校準距離必須大於 0");
    }
    this.pixelToMeter = realDistanceMeters / pixelDistance;
    return this.pixelToMeter;
  }

  /**
   * Savitzky-Golay 濾波器 (5 點二次多項式平滑)
   * 卷積係數: [-3, 12, 17, 12, -3] / 35
   * 專門用於平滑座標，同時保留拋體運動的二次多項式特徵，避免一般移動平均造成的曲率扁平化
   */
  savitzkyGolaySmooth(values) {
    const n = values.length;
    if (n < 5) return [...values];

    const result = new Array(n);
    const coeffs = [-3, 12, 17, 12, -3];
    const norm = 35;

    // 前兩點採用 3 點平滑或保留原值
    result[0] = values[0];
    result[1] = (values[0] + 2 * values[1] + values[2]) / 4;

    // 核心 5 點卷積
    for (let i = 2; i < n - 2; i++) {
      let sum = 0;
      for (let j = -2; j <= 2; j++) {
        sum += coeffs[j + 2] * values[i + j];
      }
      result[i] = sum / norm;
    }

    // 後兩點採用邊界平滑
    result[n - 2] = (values[n - 3] + 2 * values[n - 2] + values[n - 1]) / 4;
    result[n - 1] = values[n - 1];

    return result;
  }

  /**
   * 將原始逐幀像素座標陣列轉為完整物理數據 (包含平滑、v 向量、a 向量)
   * @param {Array<{t: number, x: number, y: number}>} rawPoints 原始影像偵測座標
   * @returns {Array<TrajectoryPoint>} 包含物理向量的軌跡資料
   */
  processTrajectory(rawPoints) {
    if (!rawPoints || rawPoints.length < 3) {
      return rawPoints.map(p => ({
        t: p.t,
        x: p.x,
        y: p.y,
        meterX: (p.x - this.origin.x) * this.pixelToMeter,
        meterY: (this.yAxisUp ? (this.origin.y - p.y) : (p.y - this.origin.y)) * this.pixelToMeter,
        vx: 0,
        vy: 0,
        v: 0,
        ax: 0,
        ay: 0,
        a: 0
      }));
    }

    const n = rawPoints.length;
    const rawX = rawPoints.map(p => p.x);
    const rawY = rawPoints.map(p => p.y);
    const times = rawPoints.map(p => p.t);

    // 1. Savitzky-Golay 濾波平滑像素座標
    const smoothX = this.savitzkyGolaySmooth(rawX);
    const smoothY = this.savitzkyGolaySmooth(rawY);

    // 2. 轉為物理世界公尺座標 (支援笛卡兒坐標向上為正)
    const meterX = smoothX.map(x => (x - this.origin.x) * this.pixelToMeter);
    const meterY = smoothY.map(y => (this.yAxisUp ? (this.origin.y - y) : (y - this.origin.y)) * this.pixelToMeter);

    // 3. 中心差分法計算速度向量 (Central Difference)
    // vx[i] = (meterX[i+1] - meterX[i-1]) / (times[i+1] - times[i-1])
    const vx = new Array(n).fill(0);
    const vy = new Array(n).fill(0);

    for (let i = 0; i < n; i++) {
      if (i === 0) {
        // 前向差分
        const dt = times[1] - times[0];
        vx[i] = dt > 0 ? (meterX[1] - meterX[0]) / dt : 0;
        vy[i] = dt > 0 ? (meterY[1] - meterY[0]) / dt : 0;
      } else if (i === n - 1) {
        // 後向差分
        const dt = times[n - 1] - times[n - 2];
        vx[i] = dt > 0 ? (meterX[n - 1] - meterX[n - 2]) / dt : 0;
        vy[i] = dt > 0 ? (meterY[n - 1] - meterY[n - 2]) / dt : 0;
      } else {
        // 中心差分 (高精確度)
        const dt = times[i + 1] - times[i - 1];
        vx[i] = dt > 0 ? (meterX[i + 1] - meterX[i - 1]) / dt : 0;
        vy[i] = dt > 0 ? (meterY[i + 1] - meterY[i - 1]) / dt : 0;
      }
    }

    // 速度平滑 (消除二次微分的數值雜訊放大)
    const smoothVx = this.savitzkyGolaySmooth(vx);
    const smoothVy = this.savitzkyGolaySmooth(vy);

    // 4. 計算加速度向量 (中心差分)
    const ax = new Array(n).fill(0);
    const ay = new Array(n).fill(0);

    for (let i = 0; i < n; i++) {
      if (i === 0) {
        const dt = times[1] - times[0];
        ax[i] = dt > 0 ? (smoothVx[1] - smoothVx[0]) / dt : 0;
        ay[i] = dt > 0 ? (smoothVy[1] - smoothVy[0]) / dt : 0;
      } else if (i === n - 1) {
        const dt = times[n - 1] - times[n - 2];
        ax[i] = dt > 0 ? (smoothVx[n - 1] - smoothVx[n - 2]) / dt : 0;
        ay[i] = dt > 0 ? (smoothVy[n - 1] - smoothVy[n - 2]) / dt : 0;
      } else {
        const dt = times[i + 1] - times[i - 1];
        ax[i] = dt > 0 ? (smoothVx[i + 1] - smoothVx[i - 1]) / dt : 0;
        ay[i] = dt > 0 ? (smoothVy[i + 1] - smoothVy[i - 1]) / dt : 0;
      }
    }

    // 5. 組裝完整資料結構
    return rawPoints.map((raw, i) => {
      const vMag = Math.hypot(smoothVx[i], smoothVy[i]);
      const aMag = Math.hypot(ax[i], ay[i]);
      return {
        index: i,
        t: Number(raw.t.toFixed(4)),
        rawX: Number(raw.x.toFixed(1)),
        rawY: Number(raw.y.toFixed(1)),
        x: Number(smoothX[i].toFixed(1)), // 平滑後像素 x
        y: Number(smoothY[i].toFixed(1)), // 平滑後像素 y
        meterX: Number(meterX[i].toFixed(3)),
        meterY: Number(meterY[i].toFixed(3)),
        vx: Number(smoothVx[i].toFixed(3)), // 公尺/秒
        vy: Number(smoothVy[i].toFixed(3)),
        v: Number(vMag.toFixed(3)),
        ax: Number(ax[i].toFixed(3)), // 公尺/秒^2
        ay: Number(ay[i].toFixed(3)),
        a: Number(aMag.toFixed(3)),
        // 畫布像素方向的向量 (已轉為螢幕 Canvas y 軸向下方向)
        pixelVx: Number((smoothVx[i] / this.pixelToMeter).toFixed(1)),
        pixelVy: Number(((this.yAxisUp ? -smoothVy[i] : smoothVy[i]) / this.pixelToMeter).toFixed(1)),
        pixelAx: Number((ax[i] / this.pixelToMeter).toFixed(1)),
        pixelAy: Number(((this.yAxisUp ? -ay[i] : ay[i]) / this.pixelToMeter).toFixed(1))
      };
    });
  }

  /**
   * 依據播放時間戳 t 進行物理數據內插 (以二分搜尋快速定位)
   * @param {Array} trajectory 處理後的物理軌跡陣列
   * @param {number} t 當前播放時間 (秒)
   */
  interpolateAtTime(trajectory, t) {
    if (!trajectory || trajectory.length === 0) return null;
    if (t <= trajectory[0].t) return trajectory[0];
    if (t >= trajectory[trajectory.length - 1].t) return trajectory[trajectory.length - 1];

    // 二分搜尋
    let low = 0;
    let high = trajectory.length - 1;

    while (low <= high) {
      const mid = (low + high) >> 1;
      if (trajectory[mid].t === t) {
        return trajectory[mid];
      } else if (trajectory[mid].t < t) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    const p0 = trajectory[high];
    const p1 = trajectory[low];
    if (!p0 || !p1) return p0 || p1;

    const span = p1.t - p0.t;
    const factor = span > 0 ? (t - p0.t) / span : 0;

    // 線性內插
    return {
      t: t,
      x: p0.x + (p1.x - p0.x) * factor,
      y: p0.y + (p1.y - p0.y) * factor,
      meterX: p0.meterX + (p1.meterX - p0.meterX) * factor,
      meterY: p0.meterY + (p1.meterY - p0.meterY) * factor,
      vx: p0.vx + (p1.vx - p0.vx) * factor,
      vy: p0.vy + (p1.vy - p0.vy) * factor,
      v: p0.v + (p1.v - p0.v) * factor,
      ax: p0.ax + (p1.ax - p0.ax) * factor,
      ay: p0.ay + (p1.ay - p0.ay) * factor,
      a: p0.a + (p1.a - p0.a) * factor,
      pixelVx: p0.pixelVx + (p1.pixelVx - p0.pixelVx) * factor,
      pixelVy: p0.pixelVy + (p1.pixelVy - p0.pixelVy) * factor,
      pixelAx: p0.pixelAx + (p1.pixelAx - p0.pixelAx) * factor,
      pixelAy: p0.pixelAy + (p1.pixelAy - p0.pixelAy) * factor
    };
  }
}
