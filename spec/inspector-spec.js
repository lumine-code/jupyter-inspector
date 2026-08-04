const etch = require("@lumine-code/etch");
const { Inspector, renderBundle } = require("../lib/inspector");
const { InspectorStore, buildPythonResultInspectorCode } = require("../lib/inspector-store");

// This panel used to live inside jupyter-repl and reach into its store. It now
// sees a kernel only as `jupyter.kernel` hands it over, so the fake below
// offers exactly that surface — `inspect` returning a promise, `executeWatch`
// taking a callback — and nothing else.

const flush = (component) => etch.updateSync(component);

function fakeKernel(overrides = {}) {
  return {
    language: "python",
    displayName: "Python 3",
    grammar: { name: "Python", scopeName: "source.python" },
    executed: [],
    inspected: [],
    executeWatch(code, onResults) {
      this.executed.push(code);
      this.lastOnResults = onResults;
    },
    inspect(expression, cursorPos) {
      this.inspected.push({ expression, cursorPos });
      return Promise.resolve(this.inspectResult ?? { found: true, data: { "text/plain": "docs" } });
    },
    ...overrides,
  };
}

describe("inspector store", () => {
  let store;

  beforeEach(() => {
    store = new InspectorStore();
  });

  it("reports having no kernel rather than asking one", () => {
    store.loadExpression("df");
    expect(store.error).toBe("No kernel running!");
  });

  it("refuses an empty expression", () => {
    store.load(fakeKernel(), "   ");
    expect(store.error).toBe("No code to introspect!");
  });

  it("asks a non-Python kernel about the expression as written", () => {
    const kernel = fakeKernel({ language: "julia" });
    store.load(kernel, "foo");

    expect(kernel.inspected).toEqual([{ expression: "foo", cursorPos: 3 }]);
    expect(kernel.executed).toEqual([]);
  });

  it("evaluates a Python expression to a name before inspecting it", () => {
    const kernel = fakeKernel();
    store.load(kernel, "df.head()");

    // The expression cannot be inspected directly, so it is bound first.
    expect(kernel.executed.length).toBe(1);
    expect(kernel.executed[0]).toContain("def _jupyter_inspector_eval():");
    expect(kernel.executed[0]).toContain('"df.head()"');
    expect(kernel.inspected).toEqual([]);

    kernel.lastOnResults({ stream: "status", data: "ok" });
    expect(kernel.inspected[0].expression).toMatch(/^__jupyter_inspector_result_\d+$/);
  });

  it("generates Python whose identifiers are legal", () => {
    const code = buildPythonResultInspectorCode("df", "__jupyter_inspector_result_1");

    // A hyphen here is a SyntaxError, and this code came from a package rename.
    for (const name of code.match(/_{1,2}jupyter[A-Za-z0-9_-]*/g) || []) {
      expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
    expect(code).not.toContain("jupyter-");
  });

  it("surfaces an execution error instead of a result", () => {
    const kernel = fakeKernel();
    store.load(kernel, "boom");

    kernel.lastOnResults({
      output_type: "error",
      ename: "NameError",
      evalue: "boom",
      traceback: [],
    });

    expect(store.error).toBe("NameError: boom");
    expect(store.bundle).toBe(null);
  });

  it("announces each change", () => {
    let calls = 0;
    const subscription = store.onDidUpdate(() => calls++);

    store.setExpression("df");
    store.setError("nope");
    store.reset();

    expect(calls).toBe(3);
    subscription.dispose();
  });
});

describe("inspector bundle rendering", () => {
  it("prefers html, then markdown, then plain text", () => {
    expect(renderBundle({ "text/plain": "p", "text/html": "<b>h</b>" }).props.className).toBe(
      "output-html",
    );
    expect(renderBundle({ "text/plain": "p", "text/markdown": "# m" }).props.className).toBe(
      "markdown",
    );
    expect(renderBundle({ "text/plain": "p" }).props.className).toBe("output-text");
  });

  it("has nothing to show for a bundle it cannot render", () => {
    expect(renderBundle({ "application/octet-stream": "??" })).toBe(null);
  });

  it("joins the string arrays Jupyter stores multi-line values as", () => {
    const node = renderBundle({ "text/plain": ["one\n", "two"] });
    expect(node.children[0].text).toContain("one");
  });
});

describe("inspector panel", () => {
  let component;
  let store;

  beforeEach(() => {
    store = new InspectorStore();
    component = new Inspector({ store, watchEditor: () => {} });
    flush(component);
  });

  afterEach(() => {
    component?.destroy();
    component = null;
  });

  it("says nothing is loaded before anything is", () => {
    expect(component.element.querySelector(".inspector-message").textContent).toContain(
      "No inspection loaded",
    );
  });

  it("offers an expression editor", () => {
    expect(component.element.querySelector("atom-text-editor.inspector-expression")).toBeTruthy();
  });

  it("shows a result once one arrives", () => {
    store.setBundle({ "text/plain": "the docstring" });
    flush(component);

    expect(component.element.querySelector(".inspector-result").textContent).toContain(
      "the docstring",
    );
  });

  it("shows an error in place of a result", () => {
    store.setError("No kernel running!");
    flush(component);

    expect(component.element.querySelector(".text-error").textContent).toBe("No kernel running!");
  });
});
