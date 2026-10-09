const { Emitter } = require("lumine");
const { randomUUID } = require("node:crypto");

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
  const helper = `
def _jupyter_inspector_eval():
    import ast
    _src = ${JSON.stringify(expression)}
    _target = ${JSON.stringify(targetName)}
    _tree = ast.parse(_src, mode="exec")
    _ns = dict(_user_ns)
    if _tree.body and isinstance(_tree.body[-1], ast.Expr):
        _last = ast.Expression(_tree.body.pop().value)
        if _tree.body:
            exec(compile(_tree, "<inspector>", "exec"), _ns)
        _user_ns[_target] = eval(compile(_last, "<inspector>", "eval"), _ns)
    else:
        exec(compile(_tree, "<inspector>", "exec"), _ns)
        _user_ns[_target] = None
try:
    _jupyter_inspector_eval()
finally:
    del _jupyter_inspector_eval
`;
  return `
(__builtins__ if __builtins__.__class__.__name__ == "dict" else __builtins__.__dict__)["exec"](
    ${JSON.stringify(helper)},
    {"__builtins__": __builtins__, "_user_ns": globals()}
)
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
  expression = "";
  cursorPos = 0;
  loading = false;
  error = null;
  // The ANSI text/plain of the kernel's answer — the one representation the
  // panel shows. IPython also ships a text/html form with hardcoded colours;
  // it is deliberately ignored.
  text = null;
  _requestId = 0;

  // One store per kernel wrapper, held by the session for as long as the
  // kernel runs — which is what lets the panel remember each kernel's last
  // inspection and swap back to it with the active editor.
  constructor(kernel) {
    this.kernel = kernel;
    this._temporaryId = randomUUID().replace(/-/g, "_");
    this.emitter = new Emitter();
    this.requests = new Set();
    this.generationSubscription = kernel.onDidChangeGeneration(() => {
      this._requestId++;
      for (const request of this.requests) request.dispose();
      this.requests.clear();
      this.setError("The kernel session changed. Inspect the expression again.");
    });
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
    if (this.destroyed) return;
    this.expression = text;
    this._emitUpdate();
  };

  loadExpression = (expression) => {
    if (this.destroyed) return;
    this.expression = String(expression || "");
    this.cursorPos = this.expression.length;
    this._emitUpdate();
    this._fetch();
  };

  refresh = () => {
    this.cursorPos = this.expression.length;
    this._fetch();
  };

  // Answers arriving after this are dropped by the request-id guard.
  destroy = () => {
    if (this.destroyed) return;
    this.destroyed = true;
    this._requestId++;
    for (const request of this.requests) request.dispose();
    this.requests.clear();
    this.generationSubscription?.dispose();
    this.loading = false;
    this.emitter.dispose();
  };

  _fetch = () => {
    if (this.destroyed) return;
    const requestId = ++this._requestId;
    for (const request of this.requests) request.dispose();
    this.requests.clear();
    const expression = this.expression;
    if (!this.kernel) {
      this.setError("No kernel running!");
      return;
    }
    if (!expression.trim()) {
      this.setError("No code to introspect!");
      return;
    }

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

  async _request(kernel, specification) {
    const request = kernel.request(specification);
    this.requests.add(request);
    try {
      return await request.done;
    } finally {
      this.requests.delete(request);
      request.dispose();
    }
  }

  async _inspectExpression(requestId, expression, cursorPos, scrub = null, kernel = this.kernel) {
    try {
      const result = await this._request(kernel, {
        type: "inspect",
        purpose: "query",
        code: expression,
        cursorPos,
      });
      if (requestId !== this._requestId || this.destroyed) return;
      if (result.status !== "ok") {
        this.setError(result.error?.evalue || `Inspection ${result.status}.`);
        return;
      }
      const text = result.data?.found ? asText(result.data.data?.["text/plain"]) : "";
      if (!text) this.setError("No introspection available!");
      else this.setText(scrub ? text.split(scrub.from).join(scrub.to) : text);
    } catch (error) {
      if (requestId === this._requestId) this.setError(error.message || String(error));
    }
  }

  async _fetchPythonExpressionResult(requestId, expression) {
    const kernel = this.kernel;
    const generation = kernel.generation;
    const targetName = `__jupyter_inspector_result_${this._temporaryId}_${requestId}`;
    try {
      const result = await this._request(kernel, {
        type: "execute",
        purpose: "query",
        code: buildPythonResultInspectorCode(expression, targetName),
        timeoutMs: 10000,
      });
      if (requestId !== this._requestId || this.destroyed || generation !== kernel.generation)
        return;
      if (result.status !== "ok") {
        this.setError(
          result.error ? formatExecutionError(result.error) : `Evaluation ${result.status}.`,
        );
        return;
      }
      await this._inspectExpression(
        requestId,
        targetName,
        targetName.length,
        { from: targetName, to: expression.trim() },
        kernel,
      );
    } catch (error) {
      if (requestId === this._requestId) this.setError(error.message || String(error));
    } finally {
      // Shell requests remain ordered after observation is cancelled. A queued
      // cleanup therefore follows an already accepted evaluation, and is safe
      // when cancellation prevented the evaluation from being sent at all.
      if (!kernel.destroyed && kernel.generation === generation) {
        try {
          const cleanup = kernel.request({
            type: "execute",
            purpose: "query",
            code: `globals().pop(${JSON.stringify(targetName)}, None)`,
            // Accepted evaluation may outlive this panel and its deadline.
            // Keep the queued cleanup until its original Session retires.
            timeoutMs: 0,
            collectOutputs: false,
          });
          void cleanup.done.finally(() => cleanup.dispose());
        } catch {
          /* A retired session has no temporary namespace to release. */
        }
      }
    }
  }

  setError = (message) => {
    if (this.destroyed) return;
    this.loading = false;
    this.error = message;
    this.text = null;
    this._emitUpdate();
  };

  setText = (text) => {
    if (this.destroyed) return;
    this.loading = false;
    this.error = null;
    this.text = text;
    this._emitUpdate();
  };
}

module.exports = { InspectorStore, buildPythonResultInspectorCode };
