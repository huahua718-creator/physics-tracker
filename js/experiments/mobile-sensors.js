/**
 * mobile-sensors.js
 * 手機端 5 大感測器實驗採集引擎 (WebRTC DataChannel 低功耗節流串流)
 * 模組：ACCEL_3D / INCLINE_GYRO / AUDIO_FFT / ACOUSTIC_TIMER / CAM_PHOTOGATE
 */

import { acquireWakeLock, releaseWakeLock } from "./protocol.js";

export class MobileSensorLab {
  constructor(syncManager, { onTelemetry = () => {}, onStateChange = () => {} } = {}) {
    this.sync = syncManager;
    this.onTelemetry = onTelemetry;
    this.onStateChange = onStateChange;

    this.activeMode = null;
    this.running = false;

    // 資源控制句柄 (切換實驗或停止時 100% 釋放)
    this.motionHandler = null;
    this.orientationHandler = null;
    this.mediaStream = null;
    this.audioCtx = null;
    this.scriptNode = null;
    this.rafId = null;
    this.hiddenVideo = null;
    this.photogateCanvas = null;
    this.photogateCtx = null;

    // 歸零與校準狀態
    this.accelOffset = { lax: 0, lay: 0, laz: 0 };
    this.lastRawAccel = { lax: 0, lay: 0, laz: 0 };
    this.gyroOffset = { beta: 0, gamma: 0 };
    this.lastRawGyro = { beta: 0, gamma: 0 };

    // 聲學碼錶 & 光電閘參數
    this.acousticThreshold = 0.25; // 振幅閾值 (0.05 ~ 0.90)
    this.acousticCooldownMs = 150; // 防抖盲區
    this.lastTriggerMs = 0;

    this.photogateThreshold = 100; // 亮度閾值 (0 ~ 255)
    this.photogateState = "OPEN";
    this.photogateBlockedAtMs = 0;
    this.lastLuminance = 200;
  }

  /**
   * 必須在使用者點擊手勢 (click/touchend) 同步堆疊內呼叫，以通過 iOS Safari 權限審查
   */
  async start(mode) {
    await this.stop();
    this.activeMode = mode;

    try {
      // 1. iOS 13+ Motion / Orientation 手勢授權閘門
      if (mode === "ACCEL_3D" || mode === "INCLINE_GYRO") {
        if (typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function") {
          const res = await DeviceMotionEvent.requestPermission();
          if (res !== "granted") {
            throw new Error("未取得動態感測器權限，請於 Safari 設定允許動作與方向存取");
          }
        }
        if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
          const res = await DeviceOrientationEvent.requestPermission();
          if (res !== "granted") {
            throw new Error("未取得方向感測器權限，請允許方向存取");
          }
        }
      }

      // 2. 麥克風 / 相機權限授權
      if (mode === "AUDIO_FFT" || mode === "ACOUSTIC_TIMER") {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error("瀏覽器不支援麥克風 API，請使用 HTTPS 連線開啟");
        }
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        });
      } else if (mode === "CAM_PHOTOGATE") {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error("瀏覽器不支援相機 API，請使用 HTTPS 連線開啟");
        }
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 320 },
            height: { ideal: 240 },
            frameRate: { ideal: 60 }
          },
          audio: false
        });
      }

      // 3. 鎖定螢幕常亮防休眠
      await acquireWakeLock();
      this.running = true;

      // 4. 啟動對應感測迴圈
      if (mode === "ACCEL_3D") {
        this.startAccel3D();
      } else if (mode === "INCLINE_GYRO") {
        this.startInclineGyro();
      } else if (mode === "AUDIO_FFT") {
        await this.startAudioFft();
      } else if (mode === "ACOUSTIC_TIMER") {
        await this.startAcousticTimer();
      } else if (mode === "CAM_PHOTOGATE") {
        await this.startCamPhotogate();
      }

      this.onStateChange({ running: true, mode, error: null });
      return true;
    } catch (err) {
      await this.stop();
      const msg = err?.message || String(err);
      this.onStateChange({ running: false, mode, error: msg });
      return false;
    }
  }

  /**
   * 徹底關閉感測器、音訊與鏡頭串流，確保低功耗且切換不衝突
   */
  async stop() {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.motionHandler) {
      window.removeEventListener("devicemotion", this.motionHandler);
      this.motionHandler = null;
    }
    if (this.orientationHandler) {
      window.removeEventListener("deviceorientation", this.orientationHandler);
      this.orientationHandler = null;
    }
    if (this.scriptNode) {
      try { this.scriptNode.disconnect(); } catch (e) {}
      this.scriptNode.onaudioprocess = null;
      this.scriptNode = null;
    }
    if (this.audioCtx) {
      try { await this.audioCtx.close(); } catch (e) {}
      this.audioCtx = null;
    }
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        try { track.stop(); } catch (e) {}
      }
      this.mediaStream = null;
    }
    if (this.hiddenVideo) {
      try {
        this.hiddenVideo.pause();
        this.hiddenVideo.srcObject = null;
      } catch (e) {}
      this.hiddenVideo = null;
    }
    await releaseWakeLock();
    this.onStateChange({ running: false, mode: this.activeMode, error: null });
  }

  zeroTare() {
    if (this.activeMode === "ACCEL_3D") {
      this.accelOffset = { ...this.lastRawAccel };
    } else if (this.activeMode === "INCLINE_GYRO") {
      this.gyroOffset = { ...this.lastRawGyro };
    } else if (this.activeMode === "CAM_PHOTOGATE") {
      this.photogateThreshold = Math.max(10, Math.round(this.lastLuminance * 0.5));
    }
  }

  setAcousticThreshold(val) {
    this.acousticThreshold = Math.max(0.03, Math.min(0.95, Number(val) || 0.25));
  }

  setPhotogateThreshold(val) {
    this.photogateThreshold = Math.max(5, Math.min(250, Number(val) || 100));
  }

  // --- 模組一：三軸加速度與超重/失重 (ACCEL_3D) ---
  startAccel3D() {
    let lastSent = 0;
    const round2 = (v) => Math.round((v || 0) * 100) / 100;

    this.motionHandler = (e) => {
      if (!this.running) return;
      const now = performance.now();
      if (now - lastSent < 33) return; // 鎖定 ~30 Hz
      lastSent = now;

      const ag = e.accelerationIncludingGravity || {};
      const la = e.acceleration || {};
      const rawLax = la.x ?? 0;
      const rawLay = la.y ?? 0;
      const rawLaz = la.z ?? 0;
      this.lastRawAccel = { lax: rawLax, lay: rawLay, laz: rawLaz };

      const payload = {
        ax: round2(ag.x),
        ay: round2(ag.y),
        az: round2(ag.z),
        lax: round2(rawLax - this.accelOffset.lax),
        lay: round2(rawLay - this.accelOffset.lay),
        laz: round2(rawLaz - this.accelOffset.laz)
      };

      this.sync.sendSensorPacket("ACCEL_3D", payload, now);
      this.onTelemetry(`含重力 az=${payload.az.toFixed(2)} m/s² | 線性 |a|=${Math.hypot(payload.lax, payload.lay, payload.laz).toFixed(2)} m/s²`);
    };

    window.addEventListener("devicemotion", this.motionHandler);
  }

  // --- 模組二：斜面力學與電子量角器 (INCLINE_GYRO) ---
  startInclineGyro() {
    let latestOmega = 0;
    let latestLinAcc = 0;
    let lastSent = 0;
    const deg2rad = Math.PI / 180;

    this.motionHandler = (e) => {
      if (!this.running) return;
      const rr = e.rotationRate || {};
      // rotationRate 在部分瀏覽器為 deg/s，取主要擺動軸大小轉成 rad/s
      const rateDeg = Math.max(Math.abs(rr.alpha || 0), Math.abs(rr.beta || 0), Math.abs(rr.gamma || 0));
      const sign = (rr.alpha || rr.beta || rr.gamma || 0) >= 0 ? 1 : -1;
      latestOmega = Math.round(sign * rateDeg * deg2rad * 100) / 100;

      const la = e.acceleration || {};
      latestLinAcc = Math.round(Math.hypot(la.x || 0, la.y || 0, la.z || 0) * 100) / 100;
    };

    this.orientationHandler = (e) => {
      if (!this.running) return;
      const now = performance.now();
      if (now - lastSent < 33) return; // 鎖定 ~30 Hz
      lastSent = now;

      const rawBeta = e.beta || 0;
      const rawGamma = e.gamma || 0;
      this.lastRawGyro = { beta: rawBeta, gamma: rawGamma };

      const beta = Math.round((rawBeta - this.gyroOffset.beta) * 10) / 10;
      const gamma = Math.round((rawGamma - this.gyroOffset.gamma) * 10) / 10;
      const payload = {
        beta,
        gamma,
        omega: latestOmega,
        linAcc: latestLinAcc
      };

      this.sync.sendSensorPacket("INCLINE_GYRO", payload, now);
      this.onTelemetry(`傾角 θ=${beta.toFixed(1)}° | 角速度 ω=${latestOmega.toFixed(2)} rad/s`);
    };

    window.addEventListener("devicemotion", this.motionHandler);
    window.addEventListener("deviceorientation", this.orientationHandler);
  }

  // --- 模組三：聲波示波與即時頻譜儀 (AUDIO_FFT) ---
  async startAudioFft() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new AudioCtx();
    if (this.audioCtx.state === "suspended") {
      await this.audioCtx.resume();
    }

    const source = this.audioCtx.createMediaStreamSource(this.mediaStream);
    const analyser = this.audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.65;
    source.connect(analyser);

    const freqData = new Uint8Array(analyser.frequencyBinCount);
    const timeData = new Float32Array(analyser.fftSize);
    const sampleRate = this.audioCtx.sampleRate || 48000;
    const nyquist = sampleRate / 2;
    const binHz = nyquist / analyser.frequencyBinCount;

    let lastSent = 0;

    const loop = () => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(loop);

      const now = performance.now();
      if (now - lastSent < 40) return; // 25 Hz 頻譜同步
      lastSent = now;

      analyser.getByteFrequencyData(freqData);
      analyser.getFloatTimeDomainData(timeData);

      // 計算 RMS 與分貝
      let sumSq = 0;
      for (let i = 0; i < timeData.length; i++) {
        sumSq += timeData[i] * timeData[i];
      }
      const rms = Math.min(1, Math.sqrt(sumSq / timeData.length));
      const db = rms > 1e-5 ? 20 * Math.log10(rms) : -96;

      // 0 ~ 4000 Hz 下採樣為 128 個區間
      const outBins = 128;
      const maxHz = 4000;
      const spectrum = new Array(outBins);
      let maxVal = 0;
      let maxIdxRaw = 0;

      const maxSrcIdx = Math.min(freqData.length - 2, Math.ceil(maxHz / binHz));
      for (let idx = 2; idx <= maxSrcIdx; idx++) {
        if (freqData[idx] > maxVal) {
          maxVal = freqData[idx];
          maxIdxRaw = idx;
        }
      }

      // 拋物線內插法 (Parabolic Interpolation) 提升峰值頻率精度至 ~0.1 Hz
      let peakFreq = 0;
      if (maxVal > 18 && maxIdxRaw > 1 && maxIdxRaw < freqData.length - 1) {
        const alpha = freqData[maxIdxRaw - 1];
        const beta = freqData[maxIdxRaw];
        const gamma = freqData[maxIdxRaw + 1];
        const denom = alpha - 2 * beta + gamma;
        const delta = Math.abs(denom) > 1e-6 ? 0.5 * (alpha - gamma) / denom : 0;
        peakFreq = Math.round((maxIdxRaw + delta) * binHz * 10) / 10;
      }

      for (let b = 0; b < outBins; b++) {
        const hz0 = (b / outBins) * maxHz;
        const hz1 = ((b + 1) / outBins) * maxHz;
        const i0 = Math.max(0, Math.floor(hz0 / binHz));
        const i1 = Math.min(freqData.length - 1, Math.max(i0, Math.floor(hz1 / binHz)));
        let peakInBand = 0;
        for (let k = i0; k <= i1; k++) {
          if (freqData[k] > peakInBand) peakInBand = freqData[k];
        }
        spectrum[b] = peakInBand;
      }

      const payload = {
        rms: Math.round(rms * 1000) / 1000,
        peakFreq,
        db: Math.round(db * 10) / 10,
        spectrum
      };

      this.sync.sendSensorPacket("AUDIO_FFT", payload, now);
      this.onTelemetry(`主頻 ${peakFreq.toFixed(1)} Hz | 音量 ${payload.db.toFixed(1)} dB`);
    };

    this.rafId = requestAnimationFrame(loop);
  }

  // --- 模組四：聲學碼錶與自由落體測 g 值 (ACOUSTIC_TIMER) ---
  async startAcousticTimer() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new AudioCtx();
    if (this.audioCtx.state === "suspended") {
      await this.audioCtx.resume();
    }

    const source = this.audioCtx.createMediaStreamSource(this.mediaStream);
    // ScriptProcessor 在 iOS Safari / Android Chrome 全數通用，確保逐樣本 (0.02 ms) 偵測不漏抓瞬態敲擊聲
    const bufSize = 1024;
    const processor = this.audioCtx.createScriptProcessor(bufSize, 1, 1);
    const muteGain = this.audioCtx.createGain();
    muteGain.gain.value = 0; // 靜音輸出避免現場回授嘯叫

    source.connect(processor);
    processor.connect(muteGain);
    muteGain.connect(this.audioCtx.destination);
    this.scriptNode = processor;

    const sampleRate = this.audioCtx.sampleRate || 48000;
    let lastVuSent = 0;

    processor.onaudioprocess = (evt) => {
      if (!this.running || !this.audioCtx) return;
      const samples = evt.inputBuffer.getChannelData(0);
      const blockEndAudioTime = this.audioCtx.currentTime;
      let peakAmp = 0;
      let triggerSampleIdx = -1;

      for (let i = 0; i < samples.length; i++) {
        const amp = Math.abs(samples[i]);
        if (amp > peakAmp) peakAmp = amp;
        if (triggerSampleIdx === -1 && amp >= this.acousticThreshold) {
          triggerSampleIdx = i;
        }
      }

      const nowMs = performance.now();
      if (triggerSampleIdx !== -1 && (nowMs - this.lastTriggerMs) >= this.acousticCooldownMs) {
        this.lastTriggerMs = nowMs;
        // 以硬體樣本偏移精準回推聲響發生瞬間 (秒)
        const exactAudioTime = blockEndAudioTime - (samples.length - triggerSampleIdx) / sampleRate;
        const triggerPayload = {
          event: "TRIGGER",
          audioTime: Math.round(exactAudioTime * 100000) / 100000,
          amplitude: Math.round(peakAmp * 1000) / 1000
        };
        this.sync.sendSensorPacket("ACOUSTIC_TIMER", triggerPayload, nowMs);
        this.onTelemetry(`🔔 聲響觸發！t=${triggerPayload.audioTime.toFixed(4)}s (峰值 ${Math.round(peakAmp * 100)}%)`);
      } else if (nowMs - lastVuSent > 100) {
        lastVuSent = nowMs;
        this.sync.sendSensorPacket("ACOUSTIC_TIMER", {
          event: "VU",
          level: Math.round(peakAmp * 1000) / 1000,
          threshold: this.acousticThreshold
        }, nowMs);
      }
    };
  }

  // --- 模組五：鏡頭光電閘與遮光計時器 (CAM_PHOTOGATE) ---
  async startCamPhotogate() {
    const video = document.createElement("video");
    video.playsInline = true;
    video.muted = true;
    video.srcObject = this.mediaStream;
    this.hiddenVideo = video;
    await video.play();

    if (!this.photogateCanvas) {
      this.photogateCanvas = document.createElement("canvas");
      this.photogateCanvas.width = 20;
      this.photogateCanvas.height = 20;
      this.photogateCtx = this.photogateCanvas.getContext("2d", { willReadFrequently: true });
    }

    this.photogateState = "OPEN";
    this.photogateBlockedAtMs = 0;
    let lastFluxSent = 0;

    const loop = () => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(loop);
      if (!video.videoWidth || !video.videoHeight) return;

      const sx = Math.max(0, Math.floor(video.videoWidth / 2 - 10));
      const sy = Math.max(0, Math.floor(video.videoHeight / 2 - 10));
      this.photogateCtx.drawImage(video, sx, sy, 20, 20, 0, 0, 20, 20);
      const data = this.photogateCtx.getImageData(0, 0, 20, 20).data;

      let sumLum = 0;
      const count = data.length / 4;
      for (let i = 0; i < data.length; i += 4) {
        sumLum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      }
      const lum = Math.round(sumLum / count);
      this.lastLuminance = lum;

      const nowMs = performance.now();
      const nextState = lum < this.photogateThreshold ? "BLOCKED" : "OPEN";

      if (this.photogateState === "OPEN" && nextState === "BLOCKED") {
        this.photogateState = "BLOCKED";
        this.photogateBlockedAtMs = nowMs;
        this.sync.sendSensorPacket("CAM_PHOTOGATE", {
          state: "BLOCKED",
          duration: 0,
          luminance: lum
        }, nowMs);
      } else if (this.photogateState === "BLOCKED" && nextState === "OPEN") {
        this.photogateState = "OPEN";
        const duration = Math.max(0.001, (nowMs - this.photogateBlockedAtMs) / 1000);
        this.sync.sendSensorPacket("CAM_PHOTOGATE", {
          state: "OPEN",
          duration: Math.round(duration * 10000) / 10000,
          luminance: lum
        }, nowMs);
        this.onTelemetry(`🚧 剛通過光電閘：遮光 Δt=${duration.toFixed(4)} s (亮度 ${lum})`);
      } else if (nowMs - lastFluxSent >= 40) {
        lastFluxSent = nowMs;
        this.sync.sendSensorPacket("CAM_PHOTOGATE", {
          state: nextState,
          duration: 0,
          luminance: lum
        }, nowMs);
        this.onTelemetry(`光通量 ${lum}/255 (閾值 ${this.photogateThreshold}) | ${nextState === "BLOCKED" ? "🔴 遮光中" : "🟢 暢通"}`);
      }
    };

    this.rafId = requestAnimationFrame(loop);
  }
}
