const { Disposable } = require("lumine");

// Which providers serve a watched editor: "workspace-center" matches the
// kernel-backed provider (and any provider without explicit labels), "default"
// matches the editor's own word provider.
const LABELS = ["default", "workspace-center"];

/**
 * Completion for the panel's expression editor. Optional — without the service
 * the field is still a real editor, it just offers no suggestions.
 *
 * The expression editor is built when the panel opens, which can be either side
 * of the service arriving, so an editor registered early is remembered and
 * wired up as soon as the service turns up.
 */
class AutocompleteWatchEditor {
  constructor() {
    this.watchEditor = null;
    // editor -> Disposable | null, where null marks one still waiting.
    this.editors = new Map();
  }

  consume(watchEditor) {
    this.revoke();
    const registration = {};
    this.registration = registration;
    this.watchEditor = watchEditor;

    for (const [editor, disposable] of this.editors) {
      if (!disposable) {
        this.editors.set(editor, this.watch(editor));
      }
    }

    return new Disposable(() => {
      if (this.registration === registration) this.revoke();
    });
  }

  revoke() {
    this.registration = null;
    this.watchEditor = null;
    for (const [editor, disposable] of this.editors) {
      disposable?.dispose();
      this.editors.set(editor, null);
    }
  }

  watch(editor) {
    return this.watchEditor?.(editor, LABELS) ?? null;
  }

  /**
   * Offer completions in this editor, now or as soon as the service arrives.
   * @param {TextEditor} editor
   */
  watchPanelEditor(editor) {
    if (!editor || this.editors.has(editor)) {
      return;
    }
    this.editors.set(editor, this.watch(editor));
    editor.onDidDestroy?.(() => this.forget(editor));
  }

  forget(editor) {
    this.editors.get(editor)?.dispose();
    this.editors.delete(editor);
  }
}

const autocompleteConsumer = new AutocompleteWatchEditor();

module.exports = { autocompleteConsumer, AutocompleteWatchEditor };
