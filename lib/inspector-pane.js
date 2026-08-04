const { CompositeDisposable, Disposable, Emitter } = require("atom");
const { Inspector } = require("./inspector");

const INSPECTOR_URI = "lumine://jupyter-inspector";

class InspectorPane {
  constructor(store, watchEditor) {
    this.emitter = new Emitter();
    this.element = document.createElement("div");
    this.element.classList.add("jupyter-inspector");
    this.element.tabIndex = -1;

    this.component = new Inspector({ store, watchEditor });
    this.element.appendChild(this.component.element);

    this.element.addEventListener("focus", this.redirectFocus);
    this.disposer = new CompositeDisposable(
      new Disposable(() => this.element.removeEventListener("focus", this.redirectFocus)),
      new Disposable(() => this.component.destroy()),
      atom.commands.add(this.element, {
        "jupyter-inspector:scroll-up": (event) => this.scroll(event, -1),
        "jupyter-inspector:scroll-down": (event) => this.scroll(event, 1),
      }),
    );
  }

  getTitle = () => "Inspector";
  getIconName = () => "microscope";
  getURI = () => INSPECTOR_URI;
  getDefaultLocation = () => "bottom";
  getAllowedLocations = () => ["bottom", "left", "right"];

  // Prefer the expression field, so the pane opens ready to type; fall back to
  // the result body when there is no field yet.
  getFocusTarget() {
    return (
      this.element.querySelector("atom-text-editor.inspector-expression") ||
      this.element.querySelector(".inspector-body") ||
      this.element
    );
  }

  redirectFocus = (event) => {
    if (event.target !== this.element) {
      return;
    }
    const target = this.getFocusTarget();
    if (target !== this.element) {
      requestAnimationFrame(() => target.focus?.({ preventScroll: true }));
    }
  };

  focus = () => {
    this.getFocusTarget().focus?.({ preventScroll: true });
  };

  scroll(event, direction) {
    event?.stopPropagation?.();
    const target = this.element.querySelector(".inspector-body") || this.element;
    const lineHeight = parseFloat(getComputedStyle(target).lineHeight) || 20;
    target.scrollTop += direction * lineHeight * 3;
  }

  /**
   * A pane only drops an item it is told about. Destroying the item directly —
   * which is what happens when the kernel service goes away — leaves the tab
   * behind without this.
   *
   * @param {Function} callback
   * @returns {Disposable}
   */
  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.disposer.dispose();
    this.element.remove();
    this.emitter.emit("did-destroy");
    this.emitter.dispose();
  }
}

module.exports = InspectorPane;
