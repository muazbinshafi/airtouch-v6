// BrowserCursor - drives a floating in-page cursor + dispatches real DOM
// pointer events from gesture telemetry. This is what makes the website-only
// demo "fully functional" without any local bridge.
//
// We deliberately bypass React for the per-frame render: a single overlay
// element is mutated in place inside an rAF loop.

import { TelemetryStore, type GestureKind } from "./TelemetryStore";
import { PaintStore, PaintHistory } from "./PaintStore";
import {
  GestureSettingsStore,
  isConfigurable,
  type GestureAction,
  type ConfigurableGesture,
} from "./GestureSettings";

// Module-level flag: when true, configurable static-pose actions
// (open_palm→back, fist→stop, etc.) are SUPPRESSED. The GestureTour sets
// this while it's open so practicing the gestures doesn't trigger
// destructive shortcuts like browser-back or emergency-stop.
let suppressStaticActions = false;
export function setSuppressStaticGestureActions(v: boolean) {
  suppressStaticActions = v;
}

export type CursorMode = "off" | "pointer" | "draw";

interface DrawSegment {
  x: number;
  y: number;
}

export class BrowserCursor {
  private root: HTMLDivElement;
  private dot: HTMLDivElement;
  private ring: HTMLDivElement;
  private label: HTMLDivElement;
  private drawCanvas: HTMLCanvasElement;
  private drawCtx: CanvasRenderingContext2D | null;

  private mode: CursorMode = "pointer";
  private lastGesture: GestureKind = "none";
  private lastTarget: Element | null = null;
  private isDown = false;
  private rafId = 0;
  private unsub: (() => void) | null = null;
  private lastClickAt = 0;
  private lastRightClickAt = 0;
  private lastScrollAt = 0;
  private lastBackAt = 0;
  private lastZoomAt = 0;
  private lastNextAt = 0;
  private lastDrawPt: DrawSegment | null = null;
  // Shape preview state — when drawing a shape we hold the start anchor
  // and a snapshot of the canvas to redraw the rubber-band on each frame.
  private shapeStart: DrawSegment | null = null;
  private shapeBase: ImageData | null = null;
  // Polygon / curve in-progress state. polyPts holds the committed clicks
  // for polygon / curve tools; doubleClickAt is used to detect the closing
  // double-pinch on polygon.
  private polyPts: DrawSegment[] = [];
  private polyBase: ImageData | null = null;
  private lastClickPinchAt = 0;
  // Selection (marquee) state.
  private selectRect: { x: number; y: number; w: number; h: number } | null = null;
  private selectImg: ImageData | null = null;
  private selectBase: ImageData | null = null;
  private selectDragging = false;
  private selectAnchor: DrawSegment | null = null;
  // Resize handle interaction. When set, the next drag updates the
  // corresponding edge/corner of selectRect instead of moving it.
  private selectResize: "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w" | null = null;
  // Spray throttle.
  private lastSprayAt = 0;
  private accentColor = "var(--primary)";

  // Pose-hold buffer for higher accuracy on static gestures. Tracks the
  // currently-held configurable gesture, when it started, and when it last
  // fired (per gesture). A pose must be sustained for `holdMs` and clear
  // `cooldownMs` between fires.
  private poseHeld: ConfigurableGesture | null = null;
  private poseHeldSince = 0;
  private poseFiredAt: Partial<Record<ConfigurableGesture, number>> = {};

  // Pull cursor from the active SensorPanel video rect so XY maps to the
  // visible camera frame the user sees. Falls back to viewport.
  private targetSelector = "#omnipoint-video";

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "op-browser-cursor-root";
    this.root.setAttribute("aria-hidden", "true");
    Object.assign(this.root.style, {
      position: "fixed",
      inset: "0",
      pointerEvents: "none",
      zIndex: "2147483646",
    } as CSSStyleDeclaration);

    this.drawCanvas = document.createElement("canvas");
    Object.assign(this.drawCanvas.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      opacity: "0.85",
    } as CSSStyleDeclaration);
    this.drawCtx = this.drawCanvas.getContext("2d");

    this.ring = document.createElement("div");
    Object.assign(this.ring.style, {
      position: "absolute",
      width: "44px",
      height: "44px",
      marginLeft: "-22px",
      marginTop: "-22px",
      borderRadius: "9999px",
      border: "2px solid hsl(var(--primary))",
      boxShadow:
        "0 0 0 2px hsl(var(--background) / 0.6), 0 0 18px hsl(var(--primary) / 0.55)",
      transition: "transform 90ms ease-out, background-color 120ms ease-out, opacity 120ms ease-out",
      transform: "translate3d(0,0,0) scale(1)",
      backgroundColor: "hsl(var(--primary) / 0.10)",
      willChange: "transform, background-color",
    } as CSSStyleDeclaration);

    this.dot = document.createElement("div");
    Object.assign(this.dot.style, {
      position: "absolute",
      width: "8px",
      height: "8px",
      marginLeft: "-4px",
      marginTop: "-4px",
      borderRadius: "9999px",
      backgroundColor: "hsl(var(--primary))",
      boxShadow: "0 0 10px hsl(var(--primary) / 0.85)",
      transform: "translate3d(0,0,0)",
      willChange: "transform",
    } as CSSStyleDeclaration);

    this.label = document.createElement("div");
    Object.assign(this.label.style, {
      position: "absolute",
      transform: "translate3d(0,0,0)",
      marginLeft: "28px",
      marginTop: "-10px",
      fontFamily: "ui-monospace, 'JetBrains Mono', monospace",
      fontSize: "10px",
      letterSpacing: "0.18em",
      padding: "2px 6px",
      borderRadius: "4px",
      color: "hsl(var(--primary-foreground))",
      backgroundColor: "hsl(var(--primary) / 0.92)",
      boxShadow: "0 4px 14px hsl(var(--primary) / 0.35)",
      whiteSpace: "nowrap",
      textTransform: "uppercase",
      opacity: "0",
      transition: "opacity 120ms ease-out",
      willChange: "transform, opacity",
    } as CSSStyleDeclaration);

    this.root.appendChild(this.drawCanvas);
    this.root.appendChild(this.ring);
    this.root.appendChild(this.dot);
    this.root.appendChild(this.label);
  }

  attach() {
    if (!this.root.isConnected) document.body.appendChild(this.root);
    this.resizeCanvas();
    window.addEventListener("resize", this.resizeCanvas);
    window.addEventListener("keydown", this.handleTextKey, true);
    this.unsub = TelemetryStore.subscribe(() => {/* no-op, polled in raf */});
    this.loop();
  }

  detach() {
    cancelAnimationFrame(this.rafId);
    window.removeEventListener("resize", this.resizeCanvas);
    window.removeEventListener("keydown", this.handleTextKey, true);
    this.unsub?.();
    this.unsub = null;
    if (this.isDown) {
      this.dispatchUp(this.lastTarget);
      this.isDown = false;
    }
    this.lastTarget = null;
    if (this.root.isConnected) this.root.remove();
  }

  /** Capture-phase key handler that types into the active text caret. */
  private handleTextKey = (e: KeyboardEvent) => {
    if (this.mode !== "draw") return;
    const { tool, textAnchor, textBuffer } = PaintStore.get();
    if (tool !== "text" || !textAnchor) return;
    // Don't hijack typing when an actual input/textarea is focused.
    const ae = document.activeElement as HTMLElement | null;
    if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable)) return;

    if (e.key === "Escape") {
      e.preventDefault();
      PaintStore.set({ textBuffer: "", textAnchor: null });
      return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.commitText();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      PaintStore.set({ textBuffer: textBuffer + "\n" });
      return;
    }
    if (e.key === "Backspace") {
      e.preventDefault();
      PaintStore.set({ textBuffer: textBuffer.slice(0, -1) });
      return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      PaintStore.set({ textBuffer: textBuffer + e.key });
    }
  };

  setMode(mode: CursorMode) {
    this.mode = mode;
    this.root.style.display = mode === "off" ? "none" : "block";
    if (mode !== "draw") this.lastDrawPt = null;
    if (mode === "off" && this.isDown) {
      this.dispatchUp(this.lastTarget);
      this.isDown = false;
    }
  }

  clearDrawing() {
    if (!this.drawCtx) return;
    this.drawCtx.clearRect(0, 0, this.drawCanvas.width, this.drawCanvas.height);
    this.lastDrawPt = null;
  }

  private resizeCanvas = () => {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    this.drawCanvas.width = Math.floor(window.innerWidth * dpr);
    this.drawCanvas.height = Math.floor(window.innerHeight * dpr);
    if (this.drawCtx) {
      this.drawCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.drawCtx.lineCap = "round";
      this.drawCtx.lineJoin = "round";
    }
  };

  private resolveScreenXY(nx: number, ny: number): { x: number; y: number } {
    // The gesture engine yields normalized [0..1] coordinates inside the
    // active zone of the camera frame. Map into the on-screen video rect so
    // the cursor visually tracks the user's hand. If no video element is
    // visible (e.g. user scrolled away), fall back to the full viewport.
    const target = document.querySelector(this.targetSelector) as HTMLElement | null;
    const rect = target?.getBoundingClientRect();
    if (rect && rect.width > 4 && rect.height > 4 && rect.bottom > 0 && rect.right > 0) {
      // Expand mapping to the full viewport so the cursor can reach UI
      // outside the camera tile, while still being centred on the camera
      // origin. We blend: 60% camera-rect mapping, 40% full-viewport.
      const camX = rect.left + nx * rect.width;
      const camY = rect.top + ny * rect.height;
      const vpX = nx * window.innerWidth;
      const vpY = ny * window.innerHeight;
      return { x: camX * 0.55 + vpX * 0.45, y: camY * 0.55 + vpY * 0.45 };
    }
    return { x: nx * window.innerWidth, y: ny * window.innerHeight };
  }

  private hitTest(x: number, y: number): Element | null {
    // Temporarily hide the overlay so elementFromPoint sees what's underneath.
    const prev = this.root.style.display;
    this.root.style.display = "none";
    const el = document.elementFromPoint(x, y);
    this.root.style.display = prev;
    return el;
  }

  private dispatchMove(target: Element | null, x: number, y: number) {
    if (!target) return;
    const init: PointerEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      pointerType: "mouse",
      pointerId: 1,
      isPrimary: true,
      button: -1,
      buttons: this.isDown ? 1 : 0,
    };
    if (target !== this.lastTarget) {
      if (this.lastTarget) {
        this.lastTarget.dispatchEvent(new PointerEvent("pointerout", init));
        this.lastTarget.dispatchEvent(new MouseEvent("mouseout", init));
        this.lastTarget.dispatchEvent(new PointerEvent("pointerleave", init));
        this.lastTarget.dispatchEvent(new MouseEvent("mouseleave", init));
      }
      target.dispatchEvent(new PointerEvent("pointerover", init));
      target.dispatchEvent(new MouseEvent("mouseover", init));
      target.dispatchEvent(new PointerEvent("pointerenter", init));
      target.dispatchEvent(new MouseEvent("mouseenter", init));
      this.lastTarget = target;
    }
    target.dispatchEvent(new PointerEvent("pointermove", init));
    target.dispatchEvent(new MouseEvent("mousemove", init));
  }

  private dispatchDown(target: Element | null, x: number, y: number) {
    if (!target) return;
    const init: PointerEventInit = {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y, pointerType: "mouse",
      pointerId: 1, isPrimary: true, button: 0, buttons: 1,
    };
    target.dispatchEvent(new PointerEvent("pointerdown", init));
    target.dispatchEvent(new MouseEvent("mousedown", init));
    if (target instanceof HTMLElement) target.focus({ preventScroll: true });
  }

  private dispatchUp(target: Element | null) {
    if (!target) return;
    const init: PointerEventInit = {
      bubbles: true, cancelable: true, composed: true,
      pointerType: "mouse", pointerId: 1, isPrimary: true,
      button: 0, buttons: 0,
    };
    target.dispatchEvent(new PointerEvent("pointerup", init));
    target.dispatchEvent(new MouseEvent("mouseup", init));
  }

  private dispatchClick(target: Element | null, x: number, y: number) {
    if (!target) return;
    const init: MouseEventInit = {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y, button: 0, buttons: 0,
      view: window,
    };
    target.dispatchEvent(new MouseEvent("click", init));
    // If the target is actually a label/button-ish that needs a real .click()
    // (e.g. <a> navigation), also call the native helper.
    if (target instanceof HTMLElement) {
      try { target.click(); } catch { /* noop */ }
    }
  }

  private dispatchContextMenu(target: Element | null, x: number, y: number) {
    if (!target) return;
    target.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, button: 2, buttons: 0, view: window,
      }),
    );
  }

  private dispatchWheel(target: Element | null, x: number, y: number, deltaY: number) {
    const node = target ?? document.elementFromPoint(x, y);
    if (!node) return;
    // Bubble a wheel event for any custom scrollers (carousels etc).
    node.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, deltaX: 0, deltaY, deltaMode: 0,
      }),
    );
    // Native scroll: walk up to find a scrollable ancestor and scroll it.
    let el: Element | null = node;
    while (el && el !== document.body) {
      if (el instanceof HTMLElement) {
        const style = getComputedStyle(el);
        const oy = style.overflowY;
        if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) {
          el.scrollTop += deltaY;
          return;
        }
      }
      el = el.parentElement;
    }
    window.scrollBy({ top: deltaY, behavior: "auto" });
  }

  private applyPenStyle() {
    if (!this.drawCtx) return;
    const { color, size, alpha, composite, tool } = PaintStore.get();
    const ctx = this.drawCtx;
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = composite;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = tool === "highlighter" ? Math.max(size, 14) : size;
  }

  private resetCtx() {
    if (!this.drawCtx) return;
    this.drawCtx.globalAlpha = 1;
    this.drawCtx.globalCompositeOperation = "source-over";
  }

  /** Sample the pixel at canvas coords and return its CSS hex color. */
  private pickColorAt(x: number, y: number): string | null {
    if (!this.drawCtx) return null;
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const px = Math.floor(x * dpr);
    const py = Math.floor(y * dpr);
    const data = this.drawCtx.getImageData(px, py, 1, 1).data;
    if (data[3] < 8) return null; // transparent pixel
    const toHex = (n: number) => n.toString(16).padStart(2, "0");
    return `#${toHex(data[0])}${toHex(data[1])}${toHex(data[2])}`;
  }

  /** Spatter spray paint inside a circle around (x,y). */
  private sprayAt(x: number, y: number) {
    if (!this.drawCtx) return;
    const ctx = this.drawCtx;
    const { color, size, sprayDensity } = PaintStore.get();
    ctx.fillStyle = color;
    const radius = Math.max(8, size * 2);
    const drops = Math.max(4, Math.floor(sprayDensity));
    for (let i = 0; i < drops; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * radius;
      const dx = Math.cos(a) * r;
      const dy = Math.sin(a) * r;
      ctx.beginPath();
      ctx.arc(x + dx, y + dy, 0.8 + Math.random() * 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Commit the live text buffer onto the canvas. */
  commitText() {
    if (!this.drawCtx) return;
    const { textBuffer, textAnchor, color, fontSize } = PaintStore.get();
    if (!textAnchor || !textBuffer) {
      PaintStore.set({ textBuffer: "", textAnchor: null });
      return;
    }
    const snapImg = this.snapshotCanvas();
    if (snapImg) PaintHistory.push(snapImg);
    const ctx = this.drawCtx;
    ctx.save();
    ctx.fillStyle = color;
    ctx.font = `${fontSize}px ui-sans-serif, system-ui, "Plus Jakarta Sans", sans-serif`;
    ctx.textBaseline = "top";
    const lines = textBuffer.split("\n");
    lines.forEach((line, i) => {
      ctx.fillText(line, textAnchor.x, textAnchor.y + i * (fontSize * 1.2));
    });
    ctx.restore();
    PaintStore.set({ textBuffer: "", textAnchor: null });
  }

  /** Render the in-progress text caret + buffer (preview only). */
  private drawTextPreview() {
    if (!this.drawCtx) return;
    const base = this.shapeBase ?? this.snapshotCanvas();
    if (this.shapeBase == null && base) this.shapeBase = base;
    this.restoreCanvas(base);
    const { textBuffer, textAnchor, color, fontSize } = PaintStore.get();
    if (!textAnchor) return;
    const ctx = this.drawCtx;
    ctx.save();
    ctx.fillStyle = color;
    ctx.font = `${fontSize}px ui-sans-serif, system-ui, "Plus Jakarta Sans", sans-serif`;
    ctx.textBaseline = "top";
    const lines = (textBuffer + "▍").split("\n");
    lines.forEach((line, i) => {
      ctx.fillText(line, textAnchor.x, textAnchor.y + i * (fontSize * 1.2));
    });
    ctx.restore();
  }

  /** Polygon: draw committed segments + rubber band to (x,y). */
  private drawPolyPreview(x: number, y: number) {
    if (!this.drawCtx || this.polyPts.length === 0) return;
    this.restoreCanvas(this.polyBase);
    this.applyPenStyle();
    const ctx = this.drawCtx;
    ctx.beginPath();
    ctx.moveTo(this.polyPts[0].x, this.polyPts[0].y);
    for (let i = 1; i < this.polyPts.length; i++) {
      ctx.lineTo(this.polyPts[i].x, this.polyPts[i].y);
    }
    ctx.lineTo(x, y);
    ctx.stroke();
    // Vertex dots
    ctx.fillStyle = ctx.strokeStyle as string;
    for (const p of this.polyPts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(2, ctx.lineWidth * 0.7), 0, Math.PI * 2);
      ctx.fill();
    }
    this.resetCtx();
  }

  /** 3-click curve: anchor1 → control → anchor2 (quadratic bezier). */
  private drawCurvePreview(x: number, y: number) {
    if (!this.drawCtx || this.polyPts.length === 0) return;
    this.restoreCanvas(this.polyBase);
    this.applyPenStyle();
    const ctx = this.drawCtx;
    ctx.beginPath();
    if (this.polyPts.length === 1) {
      // Just dragging from anchor → preview straight line
      ctx.moveTo(this.polyPts[0].x, this.polyPts[0].y);
      ctx.lineTo(x, y);
    } else if (this.polyPts.length === 2) {
      // Anchor1 → cursor (control) → anchor2
      ctx.moveTo(this.polyPts[0].x, this.polyPts[0].y);
      ctx.quadraticCurveTo(x, y, this.polyPts[1].x, this.polyPts[1].y);
    }
    ctx.stroke();
    this.resetCtx();
  }

  /** Marquee select rubber band. */
  private drawSelectPreview(x: number, y: number) {
    if (!this.drawCtx || !this.selectAnchor) return;
    this.restoreCanvas(this.selectBase);
    const ctx = this.drawCtx;
    ctx.save();
    ctx.strokeStyle = "rgba(59,130,246,0.95)";
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(
      this.selectAnchor.x, this.selectAnchor.y,
      x - this.selectAnchor.x, y - this.selectAnchor.y,
    );
    ctx.restore();
  }

  private snapshotCanvas(): ImageData | null {
    if (!this.drawCtx) return null;
    return this.drawCtx.getImageData(0, 0, this.drawCanvas.width, this.drawCanvas.height);
  }

  private restoreCanvas(img: ImageData | null) {
    if (!this.drawCtx || !img) return;
    this.drawCtx.putImageData(img, 0, 0);
  }

  private drawFreehand(x: number, y: number) {
    if (!this.drawCtx) return;
    const ctx = this.drawCtx;
    this.applyPenStyle();
    if (this.lastDrawPt) {
      ctx.beginPath();
      ctx.moveTo(this.lastDrawPt.x, this.lastDrawPt.y);
      ctx.lineTo(x, y);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(x, y, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    this.lastDrawPt = { x, y };
    this.resetCtx();
    void this.accentColor;
  }

  private drawShapePreview(x: number, y: number) {
    if (!this.drawCtx || !this.shapeStart) return;
    this.restoreCanvas(this.shapeBase);
    this.applyPenStyle();
    const ctx = this.drawCtx;
    const { tool } = PaintStore.get();
    const sx = this.shapeStart.x;
    const sy = this.shapeStart.y;
    ctx.beginPath();
    if (tool === "rect") {
      ctx.strokeRect(sx, sy, x - sx, y - sy);
    } else if (tool === "ellipse") {
      const cx = (sx + x) / 2;
      const cy = (sy + y) / 2;
      const rx = Math.abs(x - sx) / 2;
      const ry = Math.abs(y - sy) / 2;
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (tool === "line") {
      ctx.moveTo(sx, sy);
      ctx.lineTo(x, y);
      ctx.stroke();
    } else if (tool === "arrow") {
      ctx.moveTo(sx, sy);
      ctx.lineTo(x, y);
      ctx.stroke();
      const head = Math.max(10, ctx.lineWidth * 3);
      const ang = Math.atan2(y - sy, x - sx);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - head * Math.cos(ang - Math.PI / 7), y - head * Math.sin(ang - Math.PI / 7));
      ctx.lineTo(x - head * Math.cos(ang + Math.PI / 7), y - head * Math.sin(ang + Math.PI / 7));
      ctx.closePath();
      ctx.fill();
    }
    this.resetCtx();
  }

  /**
   * Flood-fill (paint bucket) starting at canvas coords (x, y) with the
   * current paint color. 4-connected scanline algorithm with a tolerance so
   * anti-aliased pixels still fill cleanly.
   */
  private floodFill(x: number, y: number) {
    if (!this.drawCtx) return;
    const ctx = this.drawCtx;
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const px = Math.floor(x * dpr);
    const py = Math.floor(y * dpr);
    const w = this.drawCanvas.width;
    const h = this.drawCanvas.height;
    if (px < 0 || py < 0 || px >= w || py >= h) return;
    const img = ctx.getImageData(0, 0, w, h);
    const data = img.data;
    const idx = (py * w + px) * 4;
    const sr = data[idx], sg = data[idx + 1], sb = data[idx + 2], sa = data[idx + 3];

    const { color } = PaintStore.get();
    const c = color.replace("#", "");
    const tr = parseInt(c.slice(0, 2), 16);
    const tg = parseInt(c.slice(2, 4), 16);
    const tb = parseInt(c.slice(4, 6), 16);
    if (sr === tr && sg === tg && sb === tb && sa === 255) return;

    const tol = 32;
    const matches = (i: number) =>
      Math.abs(data[i]     - sr) <= tol &&
      Math.abs(data[i + 1] - sg) <= tol &&
      Math.abs(data[i + 2] - sb) <= tol &&
      Math.abs(data[i + 3] - sa) <= tol;

    const stack: number[] = [px, py];
    while (stack.length) {
      const yy = stack.pop()!;
      const xx = stack.pop()!;
      let lx = xx;
      while (lx >= 0 && matches((yy * w + lx) * 4)) lx--;
      lx++;
      let spanAbove = false, spanBelow = false;
      for (let cx = lx; cx < w; cx++) {
        const i = (yy * w + cx) * 4;
        if (!matches(i)) break;
        data[i] = tr; data[i + 1] = tg; data[i + 2] = tb; data[i + 3] = 255;
        if (yy > 0) {
          const above = matches(((yy - 1) * w + cx) * 4);
          if (!spanAbove && above) { stack.push(cx, yy - 1); spanAbove = true; }
          else if (spanAbove && !above) spanAbove = false;
        }
        if (yy < h - 1) {
          const below = matches(((yy + 1) * w + cx) * 4);
          if (!spanBelow && below) { stack.push(cx, yy + 1); spanBelow = true; }
          else if (spanBelow && !below) spanBelow = false;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  undo() {
    if (!this.drawCtx) return;
    const prev = PaintHistory.undo();
    if (prev) {
      this.restoreCanvas(prev);
    } else {
      this.drawCtx.clearRect(0, 0, this.drawCanvas.width, this.drawCanvas.height);
    }
  }

  redo() {
    const next = PaintHistory.redo();
    if (next) this.restoreCanvas(next);
  }

  saveAsPng() {
    const url = this.drawCanvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `omnipoint-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /** Public accessor so the export module can grab the live canvas. */
  getDrawCanvas(): HTMLCanvasElement {
    return this.drawCanvas;
  }

  /** Hit-test a point against the active selection's resize handles. */
  private hitSelectHandle(x: number, y: number):
    "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w" | null {
    if (!this.selectRect) return null;
    const r = this.selectRect;
    const tol = 12;
    const nearL = Math.abs(x - r.x) <= tol;
    const nearR = Math.abs(x - (r.x + r.w)) <= tol;
    const nearT = Math.abs(y - r.y) <= tol;
    const nearB = Math.abs(y - (r.y + r.h)) <= tol;
    const inX = x >= r.x - tol && x <= r.x + r.w + tol;
    const inY = y >= r.y - tol && y <= r.y + r.h + tol;
    if (!inX || !inY) return null;
    if (nearL && nearT) return "nw";
    if (nearR && nearT) return "ne";
    if (nearL && nearB) return "sw";
    if (nearR && nearB) return "se";
    if (nearT) return "n";
    if (nearB) return "s";
    if (nearL) return "w";
    if (nearR) return "e";
    return null;
  }

  /** Re-render the selection rect with handles + the floating image. */
  private renderSelectionWithHandles() {
    if (!this.drawCtx || !this.selectRect) return;
    this.restoreCanvas(this.selectBase);
    const ctx = this.drawCtx;
    const r = this.selectRect;
    if (this.selectImg) {
      // Stretch the captured image to current rect using a temp canvas.
      const tmp = document.createElement("canvas");
      tmp.width = this.selectImg.width;
      tmp.height = this.selectImg.height;
      tmp.getContext("2d")?.putImageData(this.selectImg, 0, 0);
      ctx.drawImage(tmp, r.x, r.y, r.w, r.h);
    }
    ctx.save();
    ctx.strokeStyle = "rgba(59,130,246,0.95)";
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.setLineDash([]);
    // 8 handles
    const handles: [number, number][] = [
      [r.x, r.y], [r.x + r.w / 2, r.y], [r.x + r.w, r.y],
      [r.x, r.y + r.h / 2],             [r.x + r.w, r.y + r.h / 2],
      [r.x, r.y + r.h], [r.x + r.w / 2, r.y + r.h], [r.x + r.w, r.y + r.h],
    ];
    ctx.fillStyle = "white";
    ctx.strokeStyle = "rgba(59,130,246,1)";
    ctx.lineWidth = 1.5;
    for (const [hx, hy] of handles) {
      ctx.beginPath();
      ctx.rect(hx - 4, hy - 4, 8, 8);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Crop the canvas to the active selection. Pushes to undo stack. */
  cropToSelection() {
    if (!this.drawCtx || !this.selectRect || !this.selectImg) return;
    const snapImg = this.snapshotCanvas();
    if (snapImg) PaintHistory.push(snapImg);
    const ctx = this.drawCtx;
    const r = this.selectRect;
    ctx.clearRect(0, 0, this.drawCanvas.width, this.drawCanvas.height);
    const tmp = document.createElement("canvas");
    tmp.width = this.selectImg.width;
    tmp.height = this.selectImg.height;
    tmp.getContext("2d")?.putImageData(this.selectImg, 0, 0);
    ctx.drawImage(tmp, r.x, r.y, r.w, r.h);
    this.selectRect = null;
    this.selectImg = null;
    this.selectBase = this.snapshotCanvas();
  }

  /** Bake the current selection (commit position + size) without cropping. */
  commitSelection() {
    if (!this.selectRect) return;
    this.selectBase = this.snapshotCanvas();
    this.selectRect = null;
    this.selectImg = null;
  }

  private setLabel(text: string) {
    if (this.label.textContent !== text) this.label.textContent = text;
    this.label.style.opacity = text ? "1" : "0";
  }

  private setRingState(gesture: GestureKind) {
    let bg = "hsl(var(--primary) / 0.10)";
    let scale = 1;
    if (this.isDown) { bg = "hsl(var(--primary) / 0.45)"; scale = 0.85; }
    else if (gesture === "click") { bg = "hsl(var(--primary) / 0.55)"; scale = 0.7; }
    else if (gesture === "right_click") { bg = "hsl(var(--destructive) / 0.45)"; scale = 0.85; }
    else if (gesture === "drag") { bg = "hsl(var(--primary) / 0.5)"; scale = 0.85; }
    else if (gesture === "fist") { bg = "hsl(var(--muted) / 0.4)"; scale = 1.1; }
    else if (gesture === "open_palm") { bg = "hsl(var(--accent) / 0.30)"; scale = 1.25; }
    this.ring.style.backgroundColor = bg;
    this.ring.style.transform = `translate3d(0,0,0) scale(${scale})`;
  }

  private loop = () => {
    this.rafId = requestAnimationFrame(this.loop);
    if (this.mode === "off") return;
    const snap = TelemetryStore.get();
    if (!snap.initialized) {
      this.setLabel("");
      return;
    }
    const { x, y } = this.resolveScreenXY(snap.cursorX, snap.cursorY);
    this.ring.style.left = `${x}px`;
    this.ring.style.top = `${y}px`;
    this.dot.style.left = `${x}px`;
    this.dot.style.top = `${y}px`;
    this.label.style.left = `${x}px`;
    this.label.style.top = `${y}px`;

    const g = snap.gesture;
    this.setRingState(g);

    if (this.mode === "draw") {
      // Drawing engages on click, drag, or any sustained pinch under the
      // ratio threshold. pinchDistance is normalised by hand size so this
      // works at any distance from the camera.
      const isDrawing =
        g === "click" || g === "drag" ||
        (snap.pinchDistance > 0 && snap.pinchDistance < 0.55);
      const tool = PaintStore.get().tool;
      const isShape = PaintStore.isShape(tool);
      const isFill = PaintStore.isFill(tool);
      const isSpecial = PaintStore.isSpecial(tool);

      if (isFill) {
        // Trigger flood-fill once on the rising edge of pinch / click.
        const wasDrawing = this.lastGesture === "click" || this.lastGesture === "drag";
        if (isDrawing && !wasDrawing) {
          const snapImg = this.snapshotCanvas();
          if (snapImg) PaintHistory.push(snapImg);
          this.floodFill(x, y);
        }
        this.setLabel(isDrawing ? "FILL" : "FILL · CLICK TO POUR");
        this.tryFireStaticGesture(g, snap.confidence, "draw");
        this.lastGesture = g;
        return;
      }

      if (isSpecial) {
        const wasDrawing =
          this.lastGesture === "click" || this.lastGesture === "drag";
        const risingEdge = isDrawing && !wasDrawing;
        const fallingEdge = !isDrawing && wasDrawing;

        if (tool === "picker") {
          if (risingEdge) {
            const c = this.pickColorAt(x, y);
            if (c) {
              PaintStore.set({ color: c });
              // Auto-switch back to pen so the picked color is immediately useful.
              PaintStore.set({ tool: "pen" });
            }
          }
          this.setLabel("PICKER");
        } else if (tool === "spray") {
          if (risingEdge) {
            const snapImg = this.snapshotCanvas();
            if (snapImg) PaintHistory.push(snapImg);
          }
          if (isDrawing) {
            const now = performance.now();
            if (now - this.lastSprayAt > 16) {
              this.sprayAt(x, y);
              this.lastSprayAt = now;
            }
          }
          this.setLabel(isDrawing ? "SPRAY" : "SPRAY · PINCH TO PAINT");
        } else if (tool === "text") {
          // First click places caret; subsequent clicks reposition the caret
          // (committing the previous buffer first).
          if (risingEdge) {
            const cur = PaintStore.get();
            if (cur.textAnchor && cur.textBuffer) this.commitText();
            PaintStore.set({ textAnchor: { x, y }, textBuffer: "" });
            this.shapeBase = this.snapshotCanvas();
          }
          this.drawTextPreview();
          this.setLabel("TEXT · TYPE ON KEYBOARD");
        } else if (tool === "select") {
          if (risingEdge) {
            // Priority 1: clicked on a resize handle of an existing selection
            const handle = this.hitSelectHandle(x, y);
            if (handle && this.selectRect && this.selectImg) {
              this.selectResize = handle;
              this.selectAnchor = { x, y };
            } else {
              const inside =
                this.selectRect &&
                x >= this.selectRect.x && x <= this.selectRect.x + this.selectRect.w &&
                y >= this.selectRect.y && y <= this.selectRect.y + this.selectRect.h;
              if (inside) {
                this.selectDragging = true;
                this.selectAnchor = { x: x - this.selectRect!.x, y: y - this.selectRect!.y };
              } else {
                // Brand new marquee — commit any prior floating selection first.
                if (this.selectRect && this.selectImg) {
                  this.renderSelectionWithHandles();
                  this.selectBase = this.snapshotCanvas();
                }
                const snapImg = this.snapshotCanvas();
                if (snapImg) PaintHistory.push(snapImg);
                this.selectBase = snapImg;
                this.selectAnchor = { x, y };
                this.selectRect = null;
                this.selectImg = null;
                this.selectDragging = false;
                this.selectResize = null;
              }
            }
          }
          if (isDrawing) {
            if (this.selectResize && this.selectRect && this.selectImg) {
              // Resize the floating selection by the active handle
              const r = this.selectRect;
              const right = r.x + r.w;
              const bottom = r.y + r.h;
              if (this.selectResize.includes("w")) { r.w = right - x; r.x = x; }
              if (this.selectResize.includes("e")) { r.w = x - r.x; }
              if (this.selectResize.includes("n")) { r.h = bottom - y; r.y = y; }
              if (this.selectResize.includes("s")) { r.h = y - r.y; }
              // Disallow inverted/zero rects
              if (r.w < 4) r.w = 4;
              if (r.h < 4) r.h = 4;
              this.renderSelectionWithHandles();
            } else if (this.selectDragging && this.selectImg && this.selectRect && this.selectAnchor) {
              const nx = x - this.selectAnchor.x;
              const ny = y - this.selectAnchor.y;
              this.selectRect.x = nx;
              this.selectRect.y = ny;
              this.renderSelectionWithHandles();
            } else if (this.selectAnchor) {
              this.drawSelectPreview(x, y);
            }
          }
          if (fallingEdge) {
            if (this.selectResize) {
              // Keep selection floating; user can resize again, drag, crop, or commit
              this.selectResize = null;
              this.selectAnchor = null;
            } else if (this.selectDragging) {
              // Don't bake yet — keep floating so they can drag/resize/crop
              this.selectDragging = false;
              this.selectAnchor = null;
              this.renderSelectionWithHandles();
            } else if (this.selectAnchor) {
              const sx = Math.min(this.selectAnchor.x, x);
              const sy = Math.min(this.selectAnchor.y, y);
              const w = Math.abs(x - this.selectAnchor.x);
              const h = Math.abs(y - this.selectAnchor.y);
              if (w > 4 && h > 4 && this.drawCtx) {
                const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
                const img = this.drawCtx.getImageData(
                  Math.floor(sx * dpr), Math.floor(sy * dpr),
                  Math.floor(w * dpr), Math.floor(h * dpr),
                );
                this.selectRect = { x: sx, y: sy, w, h };
                this.selectImg = img;
                this.renderSelectionWithHandles();
              } else {
                this.selectRect = null;
                this.selectImg = null;
              }
              this.selectAnchor = null;
            }
          }
          this.setLabel(
            this.selectImg
              ? "SELECT · HANDLES TO RESIZE · DRAG TO MOVE · CROP TO COMMIT"
              : "SELECT · DRAG REGION",
          );
        } else if (tool === "polygon") {
          // Rising edge = commit a vertex. Two pinches within 350ms = close.
          if (risingEdge) {
            const now = performance.now();
            if (this.polyPts.length === 0) {
              const snapImg = this.snapshotCanvas();
              if (snapImg) PaintHistory.push(snapImg);
              this.polyBase = snapImg;
            }
            if (now - this.lastClickPinchAt < 350 && this.polyPts.length >= 2) {
              // Close the polygon.
              this.applyPenStyle();
              const ctx = this.drawCtx!;
              ctx.beginPath();
              ctx.moveTo(this.polyPts[0].x, this.polyPts[0].y);
              for (let i = 1; i < this.polyPts.length; i++) {
                ctx.lineTo(this.polyPts[i].x, this.polyPts[i].y);
              }
              ctx.closePath();
              ctx.stroke();
              this.resetCtx();
              this.polyPts = [];
              this.polyBase = null;
            } else {
              this.polyPts.push({ x, y });
            }
            this.lastClickPinchAt = now;
          }
          if (this.polyPts.length > 0) this.drawPolyPreview(x, y);
          this.setLabel(`POLYGON · ${this.polyPts.length} PT${this.polyPts.length === 1 ? "" : "S"} · DBL-PINCH TO CLOSE`);
        } else if (tool === "curve") {
          if (risingEdge) {
            if (this.polyPts.length === 0) {
              const snapImg = this.snapshotCanvas();
              if (snapImg) PaintHistory.push(snapImg);
              this.polyBase = snapImg;
              this.polyPts.push({ x, y });
            } else if (this.polyPts.length === 1) {
              this.polyPts.push({ x, y });
            } else if (this.polyPts.length === 2) {
              // Third click commits the bezier with this point as control.
              this.applyPenStyle();
              const ctx = this.drawCtx!;
              ctx.beginPath();
              ctx.moveTo(this.polyPts[0].x, this.polyPts[0].y);
              ctx.quadraticCurveTo(x, y, this.polyPts[1].x, this.polyPts[1].y);
              ctx.stroke();
              this.resetCtx();
              this.polyPts = [];
              this.polyBase = null;
            }
          }
          if (this.polyPts.length > 0) this.drawCurvePreview(x, y);
          this.setLabel(`CURVE · ${this.polyPts.length}/3 PTS`);
        }

        this.tryFireStaticGesture(g, snap.confidence, "draw");
        this.lastGesture = g;
        return;
      }

      if (isShape) {
        if (isDrawing) {
          if (!this.shapeStart) {
            const snapImg = this.snapshotCanvas();
            if (snapImg) PaintHistory.push(snapImg);
            this.shapeBase = snapImg;
            this.shapeStart = { x, y };
          }
          this.drawShapePreview(x, y);
        } else if (this.shapeStart) {
          this.shapeStart = null;
          this.shapeBase = null;
        }
        this.setLabel(isDrawing ? tool.toUpperCase() : `SHAPE · ${tool.toUpperCase()}`);
      } else {
        if (isDrawing) {
          if (!this.lastDrawPt) {
            const snapImg = this.snapshotCanvas();
            if (snapImg) PaintHistory.push(snapImg);
          }
          this.drawFreehand(x, y);
        } else {
          this.lastDrawPt = null;
        }
        this.setLabel(isDrawing ? tool.toUpperCase() : `DRAW · ${tool.toUpperCase()}`);
      }

      // Static-pose actions in DRAW mode (undo/redo/clear/save/etc) come
      // from the user's gesture bindings, gated by hold-time + cooldown.
      this.tryFireStaticGesture(g, snap.confidence, "draw");
      this.lastGesture = g;
      return;
    }

    // Pointer mode — drive real DOM events
    const target = this.hitTest(x, y);
    this.dispatchMove(target, x, y);

    const now = performance.now();
    const transitionedTo = (k: GestureKind) => g === k && this.lastGesture !== k;

    if (g === "drag" && !this.isDown) {
      this.dispatchDown(target, x, y);
      this.isDown = true;
      this.setLabel("DRAG");
    } else if (this.isDown && g !== "drag") {
      this.dispatchUp(target);
      this.dispatchClick(target, x, y);
      this.isDown = false;
    }

    if (transitionedTo("click") && now - this.lastClickAt > 220 && !this.isDown) {
      this.dispatchDown(target, x, y);
      this.dispatchUp(target);
      this.dispatchClick(target, x, y);
      this.lastClickAt = now;
      this.setLabel("CLICK");
    } else if (transitionedTo("right_click") && now - this.lastRightClickAt > 320) {
      this.dispatchContextMenu(target, x, y);
      this.lastRightClickAt = now;
      this.setLabel("RIGHT");
    } else if ((g === "scroll_up" || g === "scroll_down") && now - this.lastScrollAt > 16) {
      const delta = g === "scroll_up" ? -60 : 60;
      this.dispatchWheel(target, x, y, delta);
      this.lastScrollAt = now;
      this.setLabel(g === "scroll_up" ? "SCROLL ↑" : "SCROLL ↓");
    } else if (g === "fist") {
      this.setLabel("HOLD");
    } else if (g === "point") {
      this.setLabel("");
    } else if (g === "none") {
      this.setLabel("");
    }

    // Configurable static-pose gestures (open_palm / thumbs_up / pinky_only
    // / four_fingers / fist) — gated by hold-time + cooldown for accuracy
    // and routed through the user's gesture bindings.
    this.tryFireStaticGesture(g, snap.confidence, "pointer");

    this.lastGesture = g;
  };

  /**
   * Buffer-then-fire dispatcher for static poses. Requires the same pose
   * to be sustained for `holdMs * accuracyBias` AND respects a per-pose
   * cooldown window. Returns true if an action fired this frame.
   */
  private tryFireStaticGesture(
    g: GestureKind,
    confidence: number,
    surface: "pointer" | "draw",
  ): boolean {
    const now = performance.now();
    const settings = GestureSettingsStore.get();

    if (!isConfigurable(g)) {
      this.poseHeld = null;
      this.poseHeldSince = 0;
      return false;
    }
    const binding = settings.bindings[g];
    if (!binding.enabled) return false;
    if (confidence < settings.minConfidence) return false;
    // Tour / learning mode: skip firing destructive shortcuts.
    if (suppressStaticActions) return false;

    // Track sustained pose
    if (this.poseHeld !== g) {
      this.poseHeld = g;
      this.poseHeldSince = now;
      return false;
    }

    const requiredHold = binding.holdMs * settings.accuracyBias;
    if (now - this.poseHeldSince < requiredHold) return false;

    const lastFired = this.poseFiredAt[g] ?? 0;
    if (now - lastFired < binding.cooldownMs) return false;

    const action = surface === "pointer" ? binding.pointerAction : binding.drawAction;

    // Honor palm-scope: open_palm should only fire in the configured surface.
    if (g === "open_palm") {
      const scope = settings.palmScope;
      if (scope === "pointer_only" && surface !== "pointer") return false;
      if (scope === "draw_only" && surface !== "draw") return false;
    }

    if (action === "none") return false;

    this.executeAction(action);
    this.poseFiredAt[g] = now;
    return true;
  }

  private executeAction(action: GestureAction) {
    switch (action) {
      case "back":
        window.history.back();
        this.setLabel("← BACK");
        break;
      case "forward":
        window.history.forward();
        this.setLabel("FORWARD →");
        break;
      case "undo":
        if (this.mode === "draw") this.undo();
        else this.dispatchKey("z", 90, { ctrl: true });
        this.setLabel("UNDO");
        break;
      case "redo":
        if (this.mode === "draw") this.redo();
        else this.dispatchKey("y", 89, { ctrl: true });
        this.setLabel("REDO");
        break;
      case "zoom_in":
        this.adjustZoom(0.1);
        this.setLabel("ZOOM +");
        break;
      case "zoom_out":
        this.adjustZoom(-0.1);
        this.setLabel("ZOOM −");
        break;
      case "next":
        this.dispatchKey("ArrowRight", 39);
        this.setLabel("NEXT →");
        break;
      case "prev":
        this.dispatchKey("ArrowLeft", 37);
        this.setLabel("← PREV");
        break;
      case "save":
        if (this.mode === "draw") this.saveAsPng();
        else this.dispatchKey("s", 83, { ctrl: true });
        this.setLabel("SAVE");
        break;
      case "clear":
        if (this.mode === "draw") this.clearDrawing();
        this.setLabel("CLEAR");
        break;
      case "escape":
        this.dispatchKey("Escape", 27);
        this.setLabel("ESC");
        break;
      case "enter":
        this.dispatchKey("Enter", 13);
        this.setLabel("ENTER");
        break;
      case "space":
        this.dispatchKey(" ", 32);
        this.setLabel("SPACE");
        break;
      case "emergency_stop":
        TelemetryStore.set({ emergencyStop: true });
        this.setLabel("⛔ STOP");
        break;
      default:
        break;
    }
  }

  private adjustZoom(delta: number) {
    const cur = parseFloat((document.body.style as CSSStyleDeclaration & { zoom?: string }).zoom || "1") || 1;
    const next = Math.min(2, Math.max(0.5, cur + delta));
    (document.body.style as CSSStyleDeclaration & { zoom?: string }).zoom = String(next);
  }

  private dispatchKey(
    key: string,
    keyCode: number,
    mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {},
  ) {
    const target = document.activeElement ?? document.body;
    const init = {
      bubbles: true, cancelable: true, composed: true,
      key, code: key, keyCode, which: keyCode,
      ctrlKey: !!mods.ctrl,
      shiftKey: !!mods.shift,
      altKey: !!mods.alt,
      metaKey: !!mods.meta,
    } as KeyboardEventInit;
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
  }
}
