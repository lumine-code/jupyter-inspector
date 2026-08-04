const etch = require("@lumine-code/etch");
const { CompositeDisposable } = require("atom");
const outputRenderer = require("./output-renderer");

/** An inspection bundle only ever carries these three. */
const MEDIA_PRIORITY = ["text/html", "text/markdown", "text/plain"];

const asText = (value) => (Array.isArray(value) ? value.join("") : String(value ?? ""));

function renderBundle(bundle) {
  // jupyter-repl's renderers when they are around: same fidelity as a REPL
  // result, including media types the fallback below cannot show.
  const service = outputRenderer.get();
  if (service) {
    return service.renderRichMedia(bundle, {}, service.MEDIA_RENDERERS);
  }
  return renderFallbackBundle(bundle);
}

/** The self-contained subset: html, markdown, plain text. */
function renderFallbackBundle(bundle) {
  const mediaType = MEDIA_PRIORITY.find((type) => bundle[type] != null);
  if (!mediaType) {
    return null;
  }
  const data = asText(bundle[mediaType]);

  if (mediaType === "text/html") {
    // Kernel output is trusted enough to render, but not to run.
    return (
      <div className="output-html" innerHTML={data.replace(/<script[\s\S]*?<\/script>/gi, "")} />
    );
  }
  if (mediaType === "text/markdown") {
    const html = atom.tools.markdown.render(data, {
      sanitize: true,
      breaks: true,
      handleFrontMatter: false,
      transformImageLinks: false,
      transformLegacyLinks: false,
      transformNonFqdnLinks: false,
    });
    return <div className="output-markdown" innerHTML={html} />;
  }
  return <pre className="output-text">{data}</pre>;
}

function renderMessage(children) {
  return <div className="inspector-message">{children}</div>;
}

// The setting is a pixel count, and zero means "whatever the editor uses". A
// bare number is not a valid CSS length, so it has to carry its unit.
function resultFontSize() {
  const size = atom.config.get("jupyter-inspector.fontSize");
  return size ? `${size}px` : "inherit";
}

function clearExpressionOrAbortMultiCursor(editor, onChange, event) {
  if ((editor.getCursors?.().length || 0) > 1 || (editor.getSelections?.().length || 0) > 1) {
    event?.abortKeyBinding?.();
    return;
  }
  editor.setText("");
  onChange("");
}

/** The expression field: a real mini editor, so it gets completion and a grammar. */
class InspectorExpressionEditor {
  constructor(props) {
    this.props = props;
    etch.initialize(this);

    this.editor = atom.workspace.buildTextEditor({
      softWrapped: true,
      lineNumberGutterVisible: false,
      placeholderText: "Expression to inspect",
    });
    this.editor.element.classList.add("inspector-expression");
    if (this.props.grammar) {
      atom.grammars.assignLanguageMode(this.editor.getBuffer(), this.props.grammar.scopeName);
    }
    if (this.props.value) {
      this.editor.setText(this.props.value);
    }
    this.element.appendChild(this.editor.element);
    this.props.watchEditor?.(this.editor);

    this.disposables = new CompositeDisposable(
      this.editor.onDidChange(() => {
        // Programmatic setText in update() must not echo back into the store:
        // the emit would re-enter the parent's patch that is applying the very
        // change being echoed.
        if (this._settingText) return;
        this.props.onChange(this.editor.getText());
      }),
      atom.commands.add(this.editor.element, {
        "core:confirm": () => this.props.onConfirm(this.editor.getText()),
        "core:cancel": (event) =>
          clearExpressionOrAbortMultiCursor(this.editor, this.props.onChange, event),
        "jupyter-inspector:focus-body": () => this.props.onFocusBody?.(),
      }),
    );
  }

  focus() {
    this.editor?.element?.focus();
  }

  render() {
    return <div className="inspector-expression-editor" />;
  }

  update(props) {
    const previousGrammar = this.props.grammar;
    this.props = props;

    if (this.editor && this.editor.getText() !== props.value) {
      this._settingText = true;
      try {
        this.editor.setText(props.value || "");
      } finally {
        this._settingText = false;
      }
    }
    const scopeName = props.grammar?.scopeName;
    if (this.editor && scopeName && scopeName !== previousGrammar?.scopeName) {
      atom.grammars.assignLanguageMode(this.editor.getBuffer(), scopeName);
    }
    return etch.update(this);
  }

  destroy() {
    this.disposables.dispose();
    this.editor?.destroy();
    return etch.destroy(this);
  }
}

/** The kernel's introspection of the current expression. */
class Inspector {
  constructor({ store, watchEditor }) {
    this.store = store;
    this.watchEditor = watchEditor;
    etch.initialize(this);

    this.disposables = new CompositeDisposable(
      this.store.onDidUpdate(() => etch.update(this)),
      // A result on screen upgrades in place when jupyter-repl's renderers
      // arrive, and degrades to the fallback when they go.
      outputRenderer.onDidChange(() => etch.update(this)),
      atom.commands.add(this.refs.body, {
        "jupyter-inspector:focus-expression": () => this.focusExpression(),
      }),
    );
  }

  focusExpression = () => {
    this.refs.expression?.focus();
  };

  focusBody = () => {
    this.refs.body?.focus({ preventScroll: true });
  };

  renderResult() {
    const store = this.store;

    if (store.loading) {
      return renderMessage("Loading...");
    }
    if (store.error) {
      return renderMessage(<span className="text-error">{store.error}</span>);
    }

    const bundle = store.bundle;
    if (!bundle) {
      return renderMessage("No inspection loaded.");
    }
    const rendered = renderBundle(bundle);
    if (!rendered) {
      return renderMessage("No inspection bundle.");
    }

    return (
      <div
        className="inspector-result native-key-bindings"
        tabIndex={-1}
        style={{ fontSize: resultFontSize() }}
      >
        {rendered}
      </div>
    );
  }

  render() {
    const store = this.store;
    return (
      <div className="inspector-panel">
        <div className="inspector-controls">
          <InspectorExpressionEditor
            ref="expression"
            value={store.expression}
            onChange={store.setExpression}
            onConfirm={store.loadExpression}
            grammar={store.kernel && store.kernel.grammar}
            onFocusBody={this.focusBody}
            watchEditor={this.watchEditor}
          />
        </div>
        <div className="inspector-body" ref="body" tabIndex={0}>
          {this.renderResult()}
        </div>
      </div>
    );
  }

  update() {
    return etch.update(this);
  }

  destroy() {
    this.disposables.dispose();
    return etch.destroy(this);
  }
}

module.exports = { Inspector, renderBundle, renderFallbackBundle };
