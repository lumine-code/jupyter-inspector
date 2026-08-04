const { Emitter } = require("atom");

/**
 * Ask a Python kernel for the value of an expression, under a name that can
 * then be introspected.
 *
 * `inspect` answers about a *name* the kernel already knows, so an expression
 * like `df.head()` has to be evaluated into one first. The statements before
 * the trailing expression run in a copy of globals, so temporaries do not leak
 * into the user's namespace; only the result is bound.
 */
function buildPythonResultInspectorCode(expression, targetName) {
  return `
def _jupyter_inspector_eval():
    import ast
    _src = ${JSON.stringify(expression)}
    _target = ${JSON.stringify(targetName)}
    _tree = ast.parse(_src, mode="exec")
    _ns = dict(globals())
    if _tree.body and isinstance(_tree.body[-1], ast.Expr):
        _last = ast.Expression(_tree.body.pop().value)
        if _tree.body:
            exec(compile(_tree, "<inspector>", "exec"), _ns)
        globals()[_target] = eval(compile(_last, "<inspector>", "eval"), _ns)
    else:
        exec(compile(_tree, "<inspector>", "exec"), _ns)
        globals()[_target] = None
_jupyter_inspector_eval()
del _jupyter_inspector_eval
`;
}

// A plain or dotted Python name: something `inspect_request` resolves as-is.
const NAME_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

// Jupyter stores multi-line values as arrays of strings as often as strings.
const asText = (value) => (Array.isArray(value) ? value.join("") : String(value ?? ""));

function formatExecutionError(result) {
  if (Array.isArray(result.traceback) && result.traceback.length > 0) {
    return result.traceback.join("\n");
  }
  return `${result.ename || "Error"}: ${result.evalue || ""}`.trim();
}

class InspectorStore {
  kernel = null;
  expression = "";
  cursorPos = 0;
  loading = false;
  error = null;
  // The ANSI text/plain of the kernel's answer — the one representation the
  // panel shows. IPython also ships a text/html form with hardcoded colours;
  // it is deliberately ignored.
  text = null;
  _requestId = 0;

  constructor() {
    this.emitter = new Emitter();
  }

  /**
   * Invoke the callback whenever the expression, its result, or the
   * loading/error state changes.
   * @param {Function} callback
   * @returns {Disposable}
   */
  onDidUpdate(callback) {
    return this.emitter.on("did-update", callback);
  }

  _emitUpdate() {
    this.emitter.emit("did-update");
  }

  setExpression = (text) => {
    this.expression = text;
    this._emitUpdate();
  };

  load = (kernel, expression) => {
    this.kernel = kernel;
    this.expression = String(expression || "");
    this.cursorPos = this.expression.length;
    this._emitUpdate();
    this._fetch();
  };

  loadExpression = (expression) => {
    this.expression = String(expression || "");
    this.cursorPos = this.expression.length;
    this._emitUpdate();
    this._fetch();
  };

  refresh = () => {
    this.cursorPos = this.expression.length;
    this._fetch();
  };

  reset = () => {
    this.kernel = null;
    this.expression = "";
    this.cursorPos = 0;
    this.loading = false;
    this.error = null;
    this.text = null;
    this._requestId++;
    this._emitUpdate();
  };

  _fetch = () => {
    const expression = this.expression;
    if (!this.kernel) {
      this.setError("No kernel running!");
      return;
    }
    if (!expression.trim()) {
      this.setError("No code to introspect!");
      return;
    }

    const requestId = ++this._requestId;
    this.loading = true;
    this.error = null;
    this.cursorPos = expression.length;
    this._emitUpdate();

    if (this.kernel.language && this.kernel.language.toLowerCase() === "python") {
      // A name (plain or dotted) can be asked about directly — one round-trip,
      // nothing bound into the namespace, and the answer's header carries the
      // real name instead of a __jupyter_inspector_result temporary.
      const name = expression.trim();
      if (NAME_PATH.test(name)) {
        this._inspectExpression(requestId, name, name.length);
        return;
      }
      this._fetchPythonExpressionResult(requestId, expression);
      return;
    }

    // Any other kernel is asked about the expression as written.
    this._inspectExpression(requestId, expression, this.cursorPos);
  };

  // The service hands back a promise; a reply for a superseded request is
  // dropped rather than shown. `scrub` maps the inspected temporary's name
  // back to the expression it stands for; the name is a single identifier
  // token, so it survives IPython's colouring in one piece.
  _inspectExpression(requestId, expression, cursorPos, onDone = null, scrub = null) {
    this.kernel.inspect(expression, cursorPos).then((result) => {
      if (requestId !== this._requestId) {
        return;
      }
      onDone?.();
      const text = result.found ? asText(result.data?.["text/plain"]) : "";
      if (!text) {
        this.setError("No introspection available!");
      } else {
        this.setText(scrub ? text.split(scrub.from).join(scrub.to) : text);
      }
    });
  }

  _fetchPythonExpressionResult(requestId, expression) {
    const targetName = `__jupyter_inspector_result_${requestId}`;
    const code = buildPythonResultInspectorCode(expression, targetName);
    let failed = false;
    let inspected = false;

    // The bound result is a temporary in the user's namespace, so it goes as
    // soon as it has been introspected — or as soon as anything fails.
    const cleanup = () => {
      this.kernel?.executeWatch?.(`globals().pop(${JSON.stringify(targetName)}, None)`, () => {});
    };

    this.kernel.executeWatch(code, (result) => {
      if (requestId !== this._requestId) {
        cleanup();
        return;
      }

      if (result.output_type === "error") {
        failed = true;
        cleanup();
        this.setError(formatExecutionError(result));
        return;
      }

      if (result.stream !== "status") {
        return;
      }

      if (result.data === "error") {
        failed = true;
        cleanup();
        if (!this.error) {
          this.setError("Failed to evaluate expression.");
        }
        return;
      }

      if (result.data === "ok" && !failed && !inspected) {
        inspected = true;
        // IPython heads its answer with the name it was asked about, so the
        // temporary's name is swapped back for the expression it holds.
        this._inspectExpression(requestId, targetName, targetName.length, cleanup, {
          from: targetName,
          to: expression.trim(),
        });
      }
    });
  }

  setError = (message) => {
    this.loading = false;
    this.error = message;
    this.text = null;
    this._emitUpdate();
  };

  setText = (text) => {
    this.loading = false;
    this.error = null;
    this.text = text;
    this._emitUpdate();
  };
}

// Single shared instance for the whole package.
const inspectorStore = new InspectorStore();

module.exports = { inspectorStore, InspectorStore, buildPythonResultInspectorCode };
