import { GlideEngine } from '../engine/api';
import { clampToPlot, insidePlot, selectionSpan, Span } from '../data/zoom';

/**
 * Drag to zoom with the primary button. Runs outside React: the overlay is positioned through its
 * style, and the window listeners exist only while a drag is in progress.
 */
export class DragZoom {
  private engine: GlideEngine | null = null;
  private canvas: HTMLElement | null = null;
  private overlay: HTMLElement | null = null;
  private onZoom: ((from: number, to: number) => void) | null = null;

  private dragging = false;
  private startX = 0;
  private originLeft = 0;
  private plotLeft = 0;
  private plotWidth = 0;
  private span: Span = { left: 0, right: 0 };

  attach(engine: GlideEngine | null, canvas: HTMLElement | null): void {
    if (engine !== this.engine || canvas !== this.canvas) {
      this.cancel();
    }
    this.engine = engine;
    this.canvas = canvas;
  }

  setOverlay(el: HTMLElement | null): void {
    this.overlay = el;
  }

  setHandler(handler: ((from: number, to: number) => void) | null): void {
    this.onZoom = handler;
  }

  /** Mouse button pressed on the chart. Returns true when a drag started. */
  begin(clientX: number, clientY: number, button: number): boolean {
    const engine = this.engine;
    const canvas = this.canvas;
    if (button !== 0 || engine === null || canvas === null || this.onZoom === null || this.dragging) {
      return false;
    }
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const plot = engine.plotRect();
    if (plot.width <= 0 || !insidePlot(x, y, plot)) {
      return false;
    }
    this.dragging = true;
    this.originLeft = rect.left;
    this.startX = x;
    this.plotLeft = plot.left;
    this.plotWidth = plot.width;

    const overlay = this.overlay;
    if (overlay !== null) {
      overlay.style.top = `${plot.top}px`;
      overlay.style.height = `${plot.height}px`;
      overlay.style.left = `${x}px`;
      overlay.style.width = '0px';
      overlay.style.display = 'block';
    }
    window.addEventListener('mousemove', this.onMove);
    window.addEventListener('mouseup', this.onUp);
    window.addEventListener('keydown', this.onKey);
    return true;
  }

  /** Ends any drag in progress without zooming. */
  cancel(): void {
    if (!this.dragging) {
      return;
    }
    this.dragging = false;
    window.removeEventListener('mousemove', this.onMove);
    window.removeEventListener('mouseup', this.onUp);
    window.removeEventListener('keydown', this.onKey);
    if (this.overlay !== null) {
      this.overlay.style.display = 'none';
    }
  }

  private onMove = (event: MouseEvent): void => {
    const overlay = this.overlay;
    if (!this.dragging || overlay === null) {
      return;
    }
    const x = clampToPlot(event.clientX - this.originLeft, this.plotLeft, this.plotWidth);
    overlay.style.left = `${Math.min(x, this.startX)}px`;
    overlay.style.width = `${Math.abs(x - this.startX)}px`;
  };

  private onUp = (event: MouseEvent): void => {
    if (!this.dragging) {
      return;
    }
    const endX = event.clientX - this.originLeft;
    this.cancel();
    const engine = this.engine;
    const handler = this.onZoom;
    const span = selectionSpan(this.startX, endX, this.plotLeft, this.plotWidth, this.span);
    if (span === null || engine === null || handler === null) {
      return;
    }
    const from = engine.timeAtX(span.left);
    const to = engine.timeAtX(span.right);
    if (isFinite(from) && isFinite(to) && to > from) {
      handler(Math.round(from), Math.round(to));
    }
  };

  private onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      this.cancel();
    }
  };
}
