const { Emitter } = require("lumine");
const { InspectorStore } = require("./inspector-store");

/**
 * What the panel sees: the active kernel, and one inspection store per kernel.
 *
 * The same lifecycle as jupyter-variables' session: this package only ever
 * holds the wrappers `jupyter.kernel` hands over, keeps a store per wrapper so
 * each kernel remembers its last inspection, and drops an entry when its
 * kernel goes.
 */
class InspectorSession {
  constructor() {
    this.emitter = new Emitter();
    this.provider = null;
    this.kernel = null;
    this.stores = new Map();
    this.subscriptions = [];
  }

  /**
   * Invoke the callback whenever the active kernel changes, including to null.
   * @param {Function} callback
   * @returns {Disposable}
   */
  onDidChangeCurrentKernel(callback) {
    return this.emitter.on("did-change-kernel", callback);
  }

  setProvider(provider) {
    if (provider === this.provider || this.destroyed) return;
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    for (const store of this.stores.values()) store.destroy();
    this.stores.clear();
    this.provider = provider;
    this.subscriptions = provider
      ? [
          provider.onDidChangeKernel((kernel) => {
            if (this.provider === provider) this.setKernel(kernel);
          }),
          provider.onDidRemoveKernel((kernel) => {
            if (this.provider === provider) this.forget(kernel);
          }),
        ]
      : [];
    this.kernel = provider ? provider.getActiveKernel() : null;
    this.emitter.emit("did-change-kernel", this.kernel);
  }

  setKernel(kernel) {
    if (kernel === this.kernel) {
      return;
    }
    this.kernel = kernel || null;
    this.emitter.emit("did-change-kernel", this.kernel);
  }

  /**
   * The inspection store for a kernel, made on first ask.
   * @param {JupyterKernel} [kernel] - Defaults to the active one
   * @returns {InspectorStore|null}
   */
  storeFor(kernel = this.kernel) {
    if (this.destroyed || !kernel) {
      return null;
    }
    if (!this.stores.has(kernel)) {
      this.stores.set(kernel, new InspectorStore(kernel));
    }
    return this.stores.get(kernel);
  }

  forget(kernel) {
    this.stores.get(kernel)?.destroy();
    this.stores.delete(kernel);
    if (this.kernel === kernel) {
      this.setKernel(null);
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.subscriptions = [];
    for (const store of this.stores.values()) {
      store.destroy();
    }
    this.stores.clear();
    this.provider = null;
    this.setKernel(null);
    this.emitter.dispose();
  }
}

module.exports = InspectorSession;
