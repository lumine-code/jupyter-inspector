const etch = require("@lumine-code/etch");
const { Inspector, renderResultText } = require("../lib/inspector");
const outputRenderer = require("../lib/output-renderer");
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

  it("asks a Python kernel about a name directly", async () => {
    const kernel = fakeKernel();
    store.load(kernel, "np.array");
    await Promise.resolve();

    // Nothing to evaluate: a dotted name resolves as written, and the answer's
    // header then carries the real name, not a bound temporary.
    expect(kernel.executed).toEqual([]);
    expect(kernel.inspected).toEqual([{ expression: "np.array", cursorPos: 8 }]);
    expect(store.text).toBe("docs");
  });

  it("swaps the temporary's name back for the expression", async () => {
    const kernel = fakeKernel();
    store.load(kernel, "make()");
    kernel.inspectResult = {
      found: true,
      data: { "text/plain": "Signature: __jupyter_inspector_result_1(x)" },
    };

    kernel.lastOnResults({ stream: "status", data: "ok" });
    await Promise.resolve();
    await Promise.resolve();

    const inspectedName = kernel.inspected[0].expression;
    expect(inspectedName).toMatch(/^__jupyter_inspector_result_\d+$/);
    expect(store.text).toBe("Signature: make()(x)");
  });

  it("surfaces an execution error instead of a result", () => {
    const kernel = fakeKernel();
    store.load(kernel, "boom()");

    kernel.lastOnResults({
      output_type: "error",
      ename: "NameError",
      evalue: "boom",
      traceback: [],
    });

    expect(store.error).toBe("NameError: boom");
    expect(store.text).toBe(null);
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

describe("inspector result text rendering", () => {
  afterEach(() => outputRenderer.set(null));

  it("colours and truncates through jupyter.output when the service is there", () => {
    outputRenderer.set({
      truncateOutput: (text) => ({ text: text.slice(0, 4), truncated: true }),
      ansiNodes: (text) => `ansi(${text})`,
    });

    const node = renderResultText("Signature: np.array");

    expect(node.props.className).toBe("inspector-text");
    expect(node.children[0].text).toBe("ansi(Sign)");
    expect(node.children[1].props.className).toBe("output-truncated");
  });

  it("strips colour escapes without the service", () => {
    const esc = String.fromCharCode(27);
    const node = renderResultText(`${esc}[31mSignature:${esc}[39m np`);
    expect(node.props.className).toBe("inspector-text");
    expect(node.children[0].text).toBe("Signature: np");
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
    store.setText("the docstring");
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

describe("inspector pane", () => {
  const InspectorPane = require("../lib/inspector-pane");

  // Losing the kernel service destroys the item directly rather than through
  // `pane.destroyItem`, and a pane only drops an item that tells it so.
  it("leaves no tab behind when destroyed directly", async () => {
    const pane = new InspectorPane(new InspectorStore(), () => {});
    const workspacePane = atom.workspace.getCenter().getActivePane();
    workspacePane.addItem(pane);

    expect(workspacePane.getItems()).toContain(pane);

    pane.destroy();

    expect(workspacePane.getItems()).not.toContain(pane);
  });

  it("survives being destroyed twice", () => {
    const pane = new InspectorPane(new InspectorStore(), () => {});
    pane.destroy();
    expect(() => pane.destroy()).not.toThrow();
  });
});
