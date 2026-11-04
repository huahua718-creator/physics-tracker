/**
 * annotation.js
 * 課堂即時畫筆與白板標註模組 (解析度無關百分比座標同步)
 * 支援：筆刷、橡皮擦、復原 (Undo)、清除 (Clear) 與繪圖模式開關
 */

export class AnnotationLayer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.color = options.color || "#ef4444";
    this.lineWidth = options.lineWidth || 6;
    this.enabled = options.enabled !== undefined ? options.enabled : true;
    this.mode = options.mode || "pen"; // "pen" | "eraser"
    this.isDrawing = false;
    this.lastX = 0;
    this.lastY = 0;
    this.onDrawEvent = options.onDrawEvent || null; // 筆跡事件回呼
    this.strokes = []; // 儲存所有筆畫段落
    this.currentStrokeId = null;

    this.updatePointerEvents();
    this.initEvents();
  }

  updatePointerEvents() {
    this.canvas.style.pointerEvents = this.enabled ? "auto" : "none";
    this.canvas.style.cursor = this.enabled ? (this.mode === "eraser" ? "cell" : "crosshair") : "default";
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    this.updatePointerEvents();
  }

  setMode(mode) {
    if (["pen", "eraser"].includes(mode)) {
      this.mode = mode;
      this.updatePointerEvents();
    }
  }

  syncSize(targetElement) {
    if (!targetElement) return;
    const rect = targetElement.getBoundingClientRect();
    if (this.canvas.width !== rect.width || this.canvas.height !== rect.height) {
      this.canvas.width = rect.width;
      this.canvas.height = rect.height;
      this.redrawAll();
    }
  }

  initEvents() {
    const canvas = this.canvas;

    const startDraw = (e) => {
      if (!this.enabled) return;
      this.isDrawing = true;
      const pos = this.getEventPos(e);
      this.lastX = pos.x;
      this.lastY = pos.y;
      this.currentStrokeId = "stroke_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
    };

    const moveDraw = (e) => {
      if (!this.isDrawing || !this.enabled) return;
      const pos = this.getEventPos(e);

      // 計算標準化座標 (0.0 ~ 1.0)
      const normX0 = this.lastX / this.canvas.width;
      const normY0 = this.lastY / this.canvas.height;
      const normX1 = pos.x / this.canvas.width;
      const normY1 = pos.y / this.canvas.height;

      const strokeEvent = {
        strokeId: this.currentStrokeId,
        mode: this.mode,
        x0: normX0,
        y0: normY0,
        x1: normX1,
        y1: normY1,
        color: this.color,
        size: this.lineWidth
      };

      // 本地繪製
      this.drawSegment(strokeEvent);
      this.strokes.push(strokeEvent);

      // 觸發同步回呼
      if (this.onDrawEvent) {
        this.onDrawEvent(strokeEvent);
      }

      this.lastX = pos.x;
      this.lastY = pos.y;
    };

    const endDraw = () => {
      if (this.isDrawing) {
        this.isDrawing = false;
        this.currentStrokeId = null;
      }
    };

    // 支援 Mouse 與 Touch
    canvas.addEventListener("mousedown", startDraw);
    canvas.addEventListener("mousemove", moveDraw);
    window.addEventListener("mouseup", endDraw);

    canvas.addEventListener("touchstart", (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      startDraw(e);
    }, { passive: false });

    canvas.addEventListener("touchmove", (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      moveDraw(e);
    }, { passive: false });

    window.addEventListener("touchend", endDraw);
  }

  getEventPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    if (e.touches && e.touches.length > 0) {
      return {
        x: e.touches[0].clientX - rect.left,
        y: e.touches[0].clientY - rect.top
      };
    }
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  }

  /**
   * 繪製單一筆劃線段
   */
  drawSegment(event) {
    const ctx = this.ctx;
    const x0 = event.x0 * this.canvas.width;
    const y0 = event.y0 * this.canvas.height;
    const x1 = event.x1 * this.canvas.width;
    const y1 = event.y1 * this.canvas.height;

    ctx.save();
    if (event.mode === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.lineWidth = (event.size || 10) * 3 * (this.canvas.width / 1000);
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = event.color || "#ef4444";
      ctx.lineWidth = (event.size || 6) * (this.canvas.width / 1000);
    }

    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 接收外部同步筆劃
   */
  receiveDrawEvent(event) {
    if (event.type === "clear") {
      this.clear(false);
      return;
    }
    if (event.type === "undo") {
      this.undo(false);
      return;
    }
    this.drawSegment(event);
    this.strokes.push(event);
  }

  /**
   * 復原上一筆筆劃 (Undo)
   */
  undo(emitSync = true) {
    if (this.strokes.length === 0) return;

    // 尋找最後一個 strokeId
    const lastStroke = this.strokes[this.strokes.length - 1];
    const targetStrokeId = lastStroke.strokeId;

    if (targetStrokeId) {
      this.strokes = this.strokes.filter(s => s.strokeId !== targetStrokeId);
    } else {
      this.strokes.pop();
    }

    this.redrawAll();

    if (emitSync && this.onDrawEvent) {
      this.onDrawEvent({ type: "undo", id: "undo_" + Date.now() });
    }
  }

  /**
   * 清除白板畫布
   */
  clear(emitSync = true) {
    this.strokes = [];
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (emitSync && this.onDrawEvent) {
      this.onDrawEvent({ type: "clear", id: "clear_" + Date.now() });
    }
  }

  redrawAll() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (const stroke of this.strokes) {
      if (stroke.x0 !== undefined) {
        this.drawSegment(stroke);
      }
    }
  }

  setColor(color) {
    this.color = color;
    if (this.mode === "eraser") {
      this.setMode("pen");
    }
  }

  setSize(size) {
    this.lineWidth = size;
  }
}
