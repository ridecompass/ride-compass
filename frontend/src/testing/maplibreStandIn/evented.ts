/** 代役の出来事の購読と、押した所の地物の渡し方（MapLibre の `Evented` に当たる）。 */
type Handler = (event: Record<string, unknown>) => void;
type Listener = { readonly type: string; readonly layerId?: string; readonly handler: Handler; readonly once: boolean };

/** 押した所に描かれている地物。`layer` は描いているレイヤーの id。 */
export interface PointedFeature {
  readonly layer: string;
  readonly properties: Record<string, unknown>;
  readonly geometry?: GeoJSON.Geometry;
  /** 地物の feature-state。MapLibre は押した所の地物にいつも付けて返す（載せていなければ空）。 */
  readonly state?: Record<string, unknown>;
}

export class Evented {
  private listeners: Listener[] = [];

  /** 購読する。MapLibre と同じく、外す口（`Subscription`）を返す。 */
  on(type: string, layerIdOrHandler: string | Handler, handler?: Handler) {
    const listener: Listener =
      typeof layerIdOrHandler === "string"
        ? { type, layerId: layerIdOrHandler, handler: handler!, once: false }
        : { type, handler: layerIdOrHandler, once: false };
    this.listeners.push(listener);
    return { unsubscribe: () => (this.listeners = this.listeners.filter((entry) => entry !== listener)) };
  }

  once(type: string, handler: Handler) {
    this.listeners.push({ type, handler, once: true });
    return this;
  }

  off(type: string, layerIdOrHandler: string | Handler, handler?: Handler) {
    const [layerId, target] =
      typeof layerIdOrHandler === "string" ? [layerIdOrHandler, handler] : [undefined, layerIdOrHandler];
    this.listeners = this.listeners.filter(
      (listener) => !(listener.type === type && listener.layerId === layerId && listener.handler === target),
    );
    return this;
  }

  /** 登録の順に呼ぶ。レイヤーを指した購読へは、そのレイヤーの地物が `features` にあるときだけ、その地物を渡す。 */
  protected fire(type: string, event: Record<string, unknown> = {}, features: readonly PointedFeature[] = []) {
    for (const listener of [...this.listeners]) {
      if (listener.type !== type) continue;
      if (listener.once) this.listeners = this.listeners.filter((entry) => entry !== listener);
      if (listener.layerId === undefined) {
        listener.handler(event);
        continue;
      }
      const onLayer = features.filter((feature) => feature.layer === listener.layerId).map(asRendered);
      if (onLayer.length > 0) listener.handler({ ...event, features: onLayer });
    }
  }
}

/** 押した所の地物を、MapLibre が購読へ渡す形にする。 */
export function asRendered(feature: PointedFeature) {
  return {
    layer: { id: feature.layer },
    properties: feature.properties,
    geometry: feature.geometry,
    state: feature.state ?? {},
  };
}
