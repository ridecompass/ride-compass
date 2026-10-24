/** 地図に置く印（`Marker`）とポップアップ（`Popup`）の代役。渡された要素を地図の器へ置く。 */
import { Evented } from "./evented";
import type { StandInMap } from "./map";

type LngLat = { lng: number; lat: number };

function toLngLat(value: readonly [number, number] | LngLat): LngLat {
  return "lng" in value ? { lng: value.lng, lat: value.lat } : { lng: value[0], lat: value[1] };
}

export class LngLatBounds {
  extend() {
    return this;
  }
}

export class Marker extends Evented {
  readonly element: HTMLElement;
  draggable: boolean;
  private lngLat: LngLat = { lng: 0, lat: 0 };
  private map: StandInMap | null = null;

  constructor(options: { element: HTMLElement; draggable?: boolean }) {
    super();
    this.element = options.element;
    this.draggable = options.draggable ?? false;
  }

  setLngLat(lngLat: readonly [number, number] | LngLat) {
    this.lngLat = toLngLat(lngLat);
    return this;
  }

  getLngLat() {
    return this.lngLat;
  }

  getElement() {
    return this.element;
  }

  setRotation() {
    return this;
  }

  setDraggable(draggable: boolean) {
    this.draggable = draggable;
    return this;
  }

  addTo(map: StandInMap) {
    this.map = map;
    map.markers.add(this);
    map.getContainer().append(this.element);
    return this;
  }

  remove() {
    this.map?.markers.delete(this);
    this.element.remove();
    return this;
  }
}

export class Popup extends Evented {
  /** MapLibre と同じく、置き直すたびに読む設定（向き`anchor`等）。 */
  readonly options: { anchor?: string; offset?: number };
  private lngLat: LngLat = { lng: 0, lat: 0 };
  private content: Node | null = null;
  private onMap = false;

  constructor(options: { anchor?: string; offset?: number } = {}) {
    super();
    this.options = { ...options };
  }

  /** 地図に載っている間の、中身を収めた要素。 */
  getElement(): HTMLElement | undefined {
    return this.onMap && this.content instanceof HTMLElement ? this.content : undefined;
  }

  setLngLat(lngLat: readonly [number, number] | LngLat) {
    this.lngLat = toLngLat(lngLat);
    return this;
  }

  getLngLat() {
    return this.lngLat;
  }

  setDOMContent(content: Node) {
    this.content = content;
    return this;
  }

  addTo(map: StandInMap) {
    if (this.content !== null) map.getContainer().append(this.content);
    this.onMap = true;
    return this;
  }

  /** MapLibre と同じく、地図に載っていたときだけ "close" を出す。 */
  remove() {
    if (this.content !== null) this.content.parentNode?.removeChild(this.content);
    if (this.onMap) {
      this.onMap = false;
      this.fire("close");
    }
    return this;
  }
}
