/**
 * protocol.js
 * Physics Tracker 感測器實驗系統通用常數、實驗規格、防休眠鎖定與 CSV 匯出工具
 */

export const NODE_COLORS = [
  "#FF595E", // node_01: 亮紅
  "#1982C4", // node_02: 寶藍
  "#8AC926", // node_03: 嫩綠
  "#FFCA3A", // node_04: 金黃
  "#9B5DE5", // node_05: 亮紫
  "#00BBF9"  // node_06: 電光藍
];

export const LAB_MODES = {
  VIDEO_TRACKER: {
    id: "VIDEO_TRACKER",
    code: "0",
    title: "慢動作影像追蹤",
    shortTitle: "影像追蹤",
    icon: "📹",
    color: "#38bdf8",
    unit: "拋體 / 碰撞 / 單雙點分析",
    desc: "離線逐幀分析預錄慢動作影片、雙點比較、擬合回歸與標記影片匯出。"
  },
  ACCEL_3D: {
    id: "ACCEL_3D",
    code: "1",
    title: "三軸加速度與視重",
    shortTitle: "三軸加速度",
    icon: "⚡",
    color: "#FF595E",
    unit: "牛頓第二定律 / 電梯超重失重",
    desc: "即時 3D 加速度向量、模擬電梯體重計與運動學梯形積分 Δv。"
  },
  INCLINE_GYRO: {
    id: "INCLINE_GYRO",
    code: "2",
    title: "斜面力學與量角器",
    shortTitle: "斜面與單擺",
    icon: "📐",
    color: "#FFCA3A",
    unit: "斜角分力 / 最大靜摩擦 / 單擺",
    desc: "動態 mg sinθ 與正向力分解、滑動瞬間自動捕捉 μs = tanθs 與單擺測 g。"
  },
  AUDIO_FFT: {
    id: "AUDIO_FFT",
    code: "3",
    title: "聲波示波與頻譜儀",
    shortTitle: "頻譜示波器",
    icon: "🎵",
    color: "#8AC926",
    unit: "音調 / 響度 / 泛音與拍頻",
    desc: "0.1Hz 精度主頻與音名辨識、128 頻段即時頻譜與雙機拍頻干涉。"
  },
  ACOUSTIC_TIMER: {
    id: "ACOUSTIC_TIMER",
    code: "4",
    title: "聲學碼錶測 g 值",
    shortTitle: "聲學碼錶",
    icon: "⏱️",
    color: "#1982C4",
    unit: "自由落體 / 等加速 / 音速測量",
    desc: "AudioContext 0.02ms 解析度雙聲觸發計時，直接算出重力加速度 g。"
  },
  CAM_PHOTOGATE: {
    id: "CAM_PHOTOGATE",
    code: "5",
    title: "鏡頭光電閘計時器",
    shortTitle: "鏡頭光電閘",
    icon: "🚧",
    color: "#9B5DE5",
    unit: "遮光測速 / 雙閘加速度 / RPM",
    desc: "手機後鏡頭中央 20×20 亮度偵測，即時計算瞬時速度 v、加速度與轉速。"
  }
};

export const LAB_MODE_ORDER = [
  "VIDEO_TRACKER",
  "ACCEL_3D",
  "INCLINE_GYRO",
  "AUDIO_FFT",
  "ACOUSTIC_TIMER",
  "CAM_PHOTOGATE"
];

let wakeLockSentinel = null;

/**
 * 請求螢幕常亮鎖定 (防止實驗途中手機鎖屏斷線)
 */
export async function acquireWakeLock() {
  try {
    if (typeof navigator !== "undefined" && "wakeLock" in navigator && !wakeLockSentinel) {
      wakeLockSentinel = await navigator.wakeLock.request("screen");
      wakeLockSentinel.addEventListener("release", () => {
        wakeLockSentinel = null;
      });
      return true;
    }
  } catch (e) {
    console.warn("WakeLock 未啟用:", e.message || e);
  }
  return false;
}

/**
 * 釋放螢幕常亮鎖定
 */
export async function releaseWakeLock() {
  try {
    if (wakeLockSentinel) {
      await wakeLockSentinel.release();
      wakeLockSentinel = null;
    }
  } catch (e) {}
}

/**
 * 將數據陣列匯出為 UTF-8 BOM CSV 檔案 (支援 Excel 直接開啟中文無亂碼)
 */
export function exportCsvRows(filenamePrefix, headers, rows) {
  if (!rows || rows.length === 0) {
    throw new Error("目前尚無可匯出的實驗數據");
  }
  const escapeCell = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    headers.map(escapeCell).join(","),
    ...rows.map(r => r.map(escapeCell).join(","))
  ];
  const csv = "\uFEFF" + lines.join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  a.href = url;
  a.download = `${filenamePrefix}_${ts}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 頻率 (Hz) 轉換為十二平均律音名與音分偏差 (A4 = 440 Hz)
 */
export function freqToNoteName(freq) {
  if (!freq || freq < 20 || !isFinite(freq)) return { note: "--", cents: 0 };
  const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const midiFloat = 69 + 12 * Math.log2(freq / 440);
  const midiRound = Math.round(midiFloat);
  const cents = Math.round((midiFloat - midiRound) * 100);
  const octave = Math.floor(midiRound / 12) - 1;
  const name = noteNames[((midiRound % 12) + 12) % 12];
  return { note: `${name}${octave}`, cents };
}
