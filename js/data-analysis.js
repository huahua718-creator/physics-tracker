/**
 * data-analysis.js
 * 物理數據回歸擬合 (Curve Fitting) 與 Excel (.xlsx) 匯出模組
 */

let xlsxLoaderPromise = null;
function loadSheetJS() {
  if (typeof window !== "undefined" && window.XLSX) {
    return Promise.resolve(window.XLSX);
  }
  if (!xlsxLoaderPromise) {
    xlsxLoaderPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
      script.async = true;
      script.onload = () => {
        if (window.XLSX) resolve(window.XLSX);
        else reject(new Error("SheetJS 載入失敗"));
      };
      script.onerror = () => {
        xlsxLoaderPromise = null;
        reject(new Error("無法載入 SheetJS CDN"));
      };
      document.head.appendChild(script);
    });
  }
  return xlsxLoaderPromise;
}

/**
 * 求解 n x n 線性方程組 Ax = b (高斯消去法含列主元)
 */
function solveLinearSystem(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivotRow][col])) {
        pivotRow = r;
      }
    }
    if (Math.abs(M[pivotRow][col]) < 1e-12) return null;

    [M[col], M[pivotRow]] = [M[pivotRow], M[col]];

    const div = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= div;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      for (let j = col; j <= n; j++) {
        M[r][j] -= factor * M[col][j];
      }
    }
  }

  return M.map(row => row[n]);
}

/**
 * 對指定物理量執行曲線擬合
 * @param {Array} trajectory 軌跡點陣列
 * @param {string} targetKey "meterY" | "meterX" | "vy" | "vx" | "ay" | "ax"
 * @param {string} modelType "constant" | "linear" | "quadratic"
 */
export function computeCurveFit(trajectory, targetKey = "meterY", modelType = "quadratic") {
  if (!trajectory || trajectory.length < 3) {
    throw new Error("至少需要 3 個數據點才能執行曲線擬合");
  }

  const pts = trajectory
    .filter(p => p[targetKey] !== undefined && Number.isFinite(p[targetKey]) && Number.isFinite(p.t))
    .map(p => ({ t: p.t, y: p[targetKey] }));

  if (pts.length < 3) {
    throw new Error("有效數據點不足");
  }

  // 以 t0 平移時間基準使數值條件數最佳化 (或保留絕對時間 t)
  // 為讓方程式與圖表座標軸 (絕對 t) 直接對應，使用原時間 t 計算，但先以 tMin 中心化再展開回 t
  const n = pts.length;
  const yMean = pts.reduce((acc, p) => acc + p.y, 0) / n;

  let coeffs = []; // [c0, c1, c2] 對應 y = c0 + c1*t + c2*t^2
  let evalFn;
  let equationText = "";
  let physicsHint = "";

  const fmtSign = (val, decimals = 3) => {
    const abs = Math.abs(val).toFixed(decimals);
    return val >= 0 ? `+ ${abs}` : `- ${abs}`;
  };

  const targetNames = {
    meterX: { label: "x(t)", unit: "m" },
    meterY: { label: "y(t)", unit: "m" },
    vx: { label: "vx(t)", unit: "m/s" },
    vy: { label: "vy(t)", unit: "m/s" },
    ax: { label: "ax(t)", unit: "m/s²" },
    ay: { label: "ay(t)", unit: "m/s²" }
  };
  const meta = targetNames[targetKey] || { label: targetKey, unit: "" };

  if (modelType === "constant") {
    const c0 = yMean;
    coeffs = [c0];
    evalFn = () => c0;
    const std = Math.sqrt(pts.reduce((acc, p) => acc + (p.y - c0) ** 2, 0) / n);
    equationText = `${meta.label} = ${c0.toFixed(3)} ${meta.unit}`;
    physicsHint = `平均值 = ${c0.toFixed(3)} ± ${std.toFixed(3)} ${meta.unit}`;
  } else if (modelType === "linear") {
    let sT = 0, sTT = 0, sY = 0, sTY = 0;
    for (const p of pts) {
      sT += p.t;
      sTT += p.t * p.t;
      sY += p.y;
      sTY += p.t * p.y;
    }
    const sol = solveLinearSystem(
      [
        [n, sT],
        [sT, sTT]
      ],
      [sY, sTY]
    );
    if (!sol) throw new Error("數據共線或時間跨度過小，無法線性擬合");
    const [b, a] = sol; // y = a*t + b
    coeffs = [b, a];
    evalFn = (t) => a * t + b;
    equationText = `${meta.label} = ${a.toFixed(3)}·t ${fmtSign(b, 3)}`;
    if (targetKey === "vx" || targetKey === "vy") {
      physicsHint = `斜率 (推算加速度) = ${a.toFixed(3)} m/s²`;
    } else if (targetKey === "meterX" || targetKey === "meterY") {
      physicsHint = `斜率 (推算速度) = ${a.toFixed(3)} m/s`;
    } else {
      physicsHint = `斜率 = ${a.toFixed(3)}`;
    }
  } else {
    // 二次多項式回歸 y = A*t^2 + B*t + C (採用正規化時間提升數值穩定度，再轉換回原 t)
    const tMean = pts.reduce((acc, p) => acc + p.t, 0) / n;
    let s1 = 0, s2 = 0, s3 = 0, s4 = 0;
    let sy0 = 0, sy1 = 0, sy2 = 0;

    for (const p of pts) {
      const dt = p.t - tMean;
      const dt2 = dt * dt;
      s1 += dt;
      s2 += dt2;
      s3 += dt2 * dt;
      s4 += dt2 * dt2;
      sy0 += p.y;
      sy1 += p.y * dt;
      sy2 += p.y * dt2;
    }

    const sol = solveLinearSystem(
      [
        [n, s1, s2],
        [s1, s2, s3],
        [s2, s3, s4]
      ],
      [sy0, sy1, sy2]
    );
    if (!sol) throw new Error("無法求得穩定的二次回歸係數");

    const [p0, p1, p2] = sol; // y = p0 + p1*(t - tMean) + p2*(t - tMean)^2
    // 展開成 y = A*t^2 + B*t + C
    const A = p2;
    const B = p1 - 2 * p2 * tMean;
    const C = p0 - p1 * tMean + p2 * tMean * tMean;

    coeffs = [C, B, A];
    evalFn = (t) => A * t * t + B * t + C;
    equationText = `${meta.label} = ${A.toFixed(3)}·t² ${fmtSign(B, 3)}·t ${fmtSign(C, 3)}`;
    if (targetKey === "meterX" || targetKey === "meterY") {
      physicsHint = `二次項 A=${A.toFixed(3)} ⇒ 推算等加速度 a = 2A = ${(2 * A).toFixed(3)} m/s²`;
    } else {
      physicsHint = `頂點/曲率係數 2A = ${(2 * A).toFixed(3)}`;
    }
  }

  // 計算 R^2 與 RMSE
  let ssRes = 0;
  let ssTot = 0;
  for (const p of pts) {
    const pred = evalFn(p.t);
    ssRes += (p.y - pred) ** 2;
    ssTot += (p.y - yMean) ** 2;
  }
  const r2 = ssTot > 1e-12 ? Math.max(0, 1 - ssRes / ssTot) : 1.0;
  const rmse = Math.sqrt(ssRes / n);

  // 產生平滑繪圖取樣點
  const tMin = pts[0].t;
  const tMax = pts[pts.length - 1].t;
  const curvePoints = [];
  const steps = 120;
  for (let i = 0; i <= steps; i++) {
    const t = tMin + (i / steps) * (tMax - tMin);
    curvePoints.push({ t, val: evalFn(t) });
  }

  return {
    targetKey,
    modelType,
    coeffs,
    r2,
    rmse,
    equationText,
    physicsHint,
    curvePoints,
    evalFn
  };
}

/**
 * 將物理數據與擬合結果匯出為真正的 Excel (.xlsx) 檔案 (若離線則自動降級為 UTF-8 BOM CSV)
 */
export async function exportTrajectoryToExcel(trajectory, fitResult = null, filenamePrefix = "physics-tracker") {
  if (!trajectory || trajectory.length === 0) {
    throw new Error("目前沒有可匯出的物理數據");
  }

  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const rows = trajectory.map((pt, idx) => ({
    "影格序號": pt.index !== undefined ? pt.index : idx,
    "時間 t (s)": Number(pt.t.toFixed(4)),
    "X位移 x (m)": Number(pt.meterX.toFixed(4)),
    "Y位移 y (m)": Number(pt.meterY.toFixed(4)),
    "直線距離 d (m)": Number(Math.hypot(pt.meterX, pt.meterY).toFixed(4)),
    "X速度 vx (m/s)": Number(pt.vx.toFixed(4)),
    "Y速度 vy (m/s)": Number(pt.vy.toFixed(4)),
    "合速度 |v| (m/s)": Number(pt.v.toFixed(4)),
    "X加速度 ax (m/s²)": Number(pt.ax.toFixed(4)),
    "Y加速度 ay (m/s²)": Number(pt.ay.toFixed(4)),
    "合加速度 |a| (m/s²)": Number(pt.a.toFixed(4))
  }));

  try {
    const XLSX = await loadSheetJS();
    const wb = XLSX.utils.book_new();

    const wsData = XLSX.utils.json_to_sheet(rows);
    wsData["!cols"] = [
      { wch: 10 }, { wch: 13 }, { wch: 13 }, { wch: 13 },
      { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 16 },
      { wch: 17 }, { wch: 17 }, { wch: 18 }
    ];
    XLSX.utils.book_append_sheet(wb, wsData, "物理軌跡數據");

    if (fitResult) {
      const modelNames = {
        constant: "常數平均 (Constant)",
        linear: "一次線性回歸 (Linear)",
        quadratic: "二次拋物線回歸 (Quadratic)"
      };
      const summaryRows = [
        { "項目": "擬合物理量", "數值 / 說明": fitResult.targetKey },
        { "項目": "擬合模型", "數值 / 說明": modelNames[fitResult.modelType] || fitResult.modelType },
        { "項目": "回歸方程式", "數值 / 說明": fitResult.equationText },
        { "項目": "物理推論", "數值 / 說明": fitResult.physicsHint },
        { "項目": "判定係數 R²", "數值 / 說明": Number(fitResult.r2.toFixed(5)) },
        { "項目": "均方根誤差 RMSE", "數值 / 說明": Number(fitResult.rmse.toFixed(5)) }
      ];
      const wsFit = XLSX.utils.json_to_sheet(summaryRows);
      wsFit["!cols"] = [{ wch: 20 }, { wch: 52 }];
      XLSX.utils.book_append_sheet(wb, wsFit, "曲線擬合結果");
    }

    XLSX.writeFile(wb, `${filenamePrefix}_${timestamp}.xlsx`);
    return { format: "xlsx", count: rows.length };
  } catch (err) {
    console.warn("SheetJS 無法載入，改為匯出 UTF-8 CSV 備援:", err);
    const headers = Object.keys(rows[0]);
    const csvLines = [
      headers.join(","),
      ...rows.map(r => headers.map(h => r[h]).join(","))
    ];
    const csvContent = "\uFEFF" + csvLines.join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filenamePrefix}_${timestamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    return { format: "csv", count: rows.length };
  }
}
