/** @jsx etch.dom */
const etch = require("@lumine-code/etch");
const { CompositeDisposable } = require("atom");
const outputRenderer = require("./output-renderer");

// The one representation the panel shows: the kernel's ANSI text/plain,
// rendered in an ordinary div rather than a <pre>. UI themes style pre
// globally (background, padding, its own overflow), which turned the result
// into a scroll box of its own instead of letting .inspector-body scroll;
// whitespace is preserved by the stylesheet instead.
function renderResultText(text) {
  const service = outputRenderer.get();
  if (service) {
    const { text: shown, truncated } = service.truncateOutput(text);
    return (
      <div className="inspector-text">
        {service.ansiNodes(shown)}
        {truncated ? <div className="output-truncated">... output truncated</div> : null}
      </div>
    );
  }
  // Without jupyter-repl's ANSI renderer the colour escapes would print as
  // garbage, so they are stripped. Built at runtime because a control
  // character in a regex literal is a lint error.
  const escapes = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
  return <div className="inspector-text">{text.replace(escapes, "")}</div>;
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
    // A form control, not a document: the editor draws the shared input box.
    this.editor.element.setAttribute("input", "");
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

/** The active kernel's introspection of its remembered expression. */
class Inspector {
  constructor({ session, watchEditor }) {
    this.session = session;
    this.watchEditor = watchEditor;
    this.storeSubscription = null;
    etch.initialize(this);

    this.disposables = new CompositeDisposable(
      // Results belong to a kernel, so the subscription moves with the
      // active one — the jupyter-variables lifecycle.
      this.session.onDidChangeCurrentKernel(() => this.watchCurrentKernel()),
      // A result on screen upgrades in place when jupyter-repl's renderers
      // arrive, and degrades to the fallback when they go.
      outputRenderer.onDidChange(() => etch.update(this)),
      atom.commands.add(this.refs.body, {
        "jupyter-inspector:focus-expression": () => this.focusExpression(),
      }),
    );

    this.watchCurrentKernel();
  }

  watchCurrentKernel() {
    this.storeSubscription?.dispose();
    const store = this.session.storeFor();
    this.storeSubscription = store ? store.onDidUpdate(() => etch.update(this)) : null;
    etch.update(this);
  }

  focusExpression = () => {
    this.refs.expression?.focus();
  };

  focusBody = () => {
    this.refs.body?.focus({ preventScroll: true });
  };

  renderResult(store) {
    if (store.loading) {
      return renderMessage("Loading...");
    }
    if (store.error) {
      return renderMessage(<span className="text-error">{store.error}</span>);
    }

    if (store.text == null) {
      return renderMessage("No inspection loaded.");
    }

    return (
      <div
        className="inspector-result native-key-bindings"
        tabIndex={-1}
        style={{ fontSize: resultFontSize() }}
      >
        {renderResultText(store.text)}
      </div>
    );
  }

  render() {
    const store = this.session.storeFor();
    if (!store) {
      // The big centred empty-state every sidebar panel shows, the variables
      // panel included — not the small in-flow note used between results.
      return (
        <div className="inspector-panel">
          <div className="inspector-body" ref="body" tabIndex={0}>
            <background-tips>
              <ul className="centered background-message">
                <li>No kernel running</li>
              </ul>
            </background-tips>
          </div>
        </div>
      );
    }
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
          {this.renderResult(store)}
        </div>
      </div>
    );
  }

  update() {
    return etch.update(this);
  }

  destroy() {
    this.storeSubscription?.dispose();
    this.disposables.dispose();
    return etch.destroy(this);
  }
}

module.exports = { Inspector, renderResultText };
