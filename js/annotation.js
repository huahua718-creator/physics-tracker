/**
 * annotation.js
 * 課堂即時畫筆與白板標註模組 (解析度無關百分比座標同步)
 */

export class AnnotationLayer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.color = options.color || "#ff3b30";
    this.lineWidth = options.lineWidth || 4;
    this.isDrawing = false;
    this.lastX = 0;
    this.lastY = 0;
    this.onDrawEvent = options.onDrawEvent || null; // 筆跡事件回呼
    this.strokes = []; // 儲存歷史筆跡以便重繪

    this.initEvents();
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
      this.isDrawing = true;
      const pos = this.getEventPos(e);
      this.lastX = pos.x;
      this.lastY = pos.y;
    };

    const moveDraw = (e) => {
      if (!this.isDrawing) return;
      const pos = this.getEventPos(e);

      // 計算標準化座標 (0.0 ~ 1.0)
      const normX0 = this.lastX / this.canvas.width;
      const normY0 = this.lastY / this.canvas.height;
      const normX1 = pos.x / this.canvas.width;
      const normY1 = pos.y / this.canvas.height;

      const strokeEvent = {
        id: "draw_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
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
      this.isDrawing = false;
    };

    // 支援 Mouse 與 Touch
    canvas.addEventListener("mousedown", startDraw);
    canvas.addEventListener("mousemove", moveDraw);
    window.addEventListener("mouseup", endDraw);

    canvas.addEventListener("touchstart", (e) => {
      e.preventDefault();
      startDraw(e);
    }, { passive: false });

    canvas.addEventListener("touchmove", (e) => {
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
   * 繪製單一筆劃線段 (依據標準化座標轉成當前 Canvas 實體像素)
   */
  drawSegment(event) {
    const ctx = this.ctx;
    const x0 = event.x0 * this.canvas.width;
    const y0 = event.y0 * this.canvas.height;
    const x1 = event.x1 * this.canvas.width;
    const y1 = event.y1 * this.canvas.height;

    ctx.save();
    ctx.strokeStyle = event.color || "#ff3b30";
    ctx.lineWidth = (event.size || 4) * (this.canvas.width / 1000); // 隨解析度等比縮放
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
      this.clear();
      return;
    }
    this.drawSegment(event);
    this.strokes.push(event);
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
  }

  setSize(size) {
    this.lineWidth = size;
  }
}
