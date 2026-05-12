// URL hash state save/restore — each dashboard supplies its own schema.
//
// Usage:
//   const urlState = new UrlState([
//     { key: "shot", get: () => state.currentShot, set: (v) => state.currentShot = v, default: "5" },
//     ...
//   ]);
//   urlState.load();        // restore from window.location.hash
//   urlState.save();        // write to window.location.hash (debounced)

export class UrlState {
  constructor(fields, { mode = "hash" } = {}) {
    this.fields = fields;          // [{key, get, set, default, encode?, decode?}]
    this.mode = mode;              // "hash" or "search"
  }

  _readParams() {
    const raw = this.mode === "hash"
      ? window.location.hash.slice(1)
      : window.location.search.slice(1);
    return new URLSearchParams(raw);
  }

  _writeParams(params) {
    const str = params.toString();
    if (this.mode === "hash") {
      const newHash = str ? "#" + str : "";
      if (window.location.hash !== newHash) {
        history.replaceState(null, "", window.location.pathname + window.location.search + newHash);
      }
    } else {
      const newSearch = str ? "?" + str : "";
      if (window.location.search !== newSearch) {
        history.replaceState(null, "", window.location.pathname + newSearch + window.location.hash);
      }
    }
  }

  /** Read params from the URL and apply via field setters. Returns true if any field was set. */
  load() {
    const params = this._readParams();
    let loaded = false;
    for (const f of this.fields) {
      if (!params.has(f.key)) continue;
      const raw = params.get(f.key);
      const value = f.decode ? f.decode(raw) : raw;
      f.set(value);
      loaded = true;
    }
    return loaded;
  }

  /** Whether a given key is present in the URL. */
  has(key) {
    return this._readParams().has(key);
  }

  /** Write current field values to the URL. Omits fields equal to their default. */
  save() {
    const params = new URLSearchParams();
    for (const f of this.fields) {
      const val = f.get();
      const encoded = f.encode ? f.encode(val) : String(val);
      // Always include if `noDefault` is set; otherwise only if it differs from default.
      const def = typeof f.default === "function" ? f.default() : f.default;
      const encodedDefault = def === undefined ? undefined
                          : (f.encode ? f.encode(def) : String(def));
      if (f.noDefault || encoded !== encodedDefault) {
        if (encoded !== "" && encoded != null) params.set(f.key, encoded);
      }
    }
    this._writeParams(params);
  }
}
