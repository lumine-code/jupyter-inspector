const etch = require("@lumine-code/etch");
const { Inspector, renderBundle, renderFallbackBundle } = require("../lib/inspector");
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
    expect(store.bundle).toEqual({ "text/plain": "docs" });
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
    expect(store.bundle["text/plain"]).toBe("Signature: make()(x)");
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
  afterEach(() => outputRenderer.set(null));

  it("prefers html, then markdown, then plain text without the service", () => {
    expect(
      renderFallbackBundle({ "text/plain": "p", "text/html": "<b>h</b>" }).props.className,
    ).toBe("output-html");
    expect(
      renderFallbackBundle({ "text/plain": "p", "text/markdown": "# m" }).props.className,
    ).toBe("output-markdown");
    expect(renderFallbackBundle({ "text/plain": "p" }).props.className).toBe("inspector-text");
  });

  it("has nothing to show for a bundle it cannot render", () => {
    expect(renderFallbackBundle({ "application/octet-stream": "??" })).toBe(null);
  });

  it("joins the string arrays Jupyter stores multi-line values as", () => {
    const node = renderFallbackBundle({ "text/plain": ["one\n", "two"] });
    expect(node.children[0].text).toContain("one");
  });

  it("shows the plain text even when richer types are in the bundle", () => {
    // IPython 9 pairs the ANSI text/plain with a text/html document carrying
    // a hardcoded light palette; the plain form follows the theme, rendered
    // through the service's ANSI mapper in a plain div — a <pre> picks up the
    // UI theme's block styling and scrolls by itself instead of the body.
    let ansiCalls = 0;
    outputRenderer.set({
      MEDIA_RENDERERS: {},
      truncateOutput: (text) => ({ text, truncated: false }),
      ansiNodes(text) {
        ansiCalls++;
        return text;
      },
      renderRichMedia() {
        throw new Error("the rich renderers must not see a bundle with text/plain");
      },
    });

    const node = renderBundle({ "text/plain": "p", "text/html": "<h1>Signature</h1>" });

    expect(node.props.className).toBe("inspector-text");
    expect(ansiCalls).toBe(1);
  });

  it("strips colour escapes when rendering plain text without the service", () => {
    const esc = String.fromCharCode(27);
    const node = renderFallbackBundle({ "text/plain": `${esc}[31mSignature:${esc}[39m np` });
    expect(node.props.className).toBe("inspector-text");
    expect(node.children[0].text).toBe("Signature: np");
  });

  it("renders through jupyter.output when the service is there", () => {
    const bundles = [];
    outputRenderer.set({
      MEDIA_RENDERERS: {},
      renderRichMedia(bundle) {
        bundles.push(bundle);
        return { tag: "div", props: { className: "service-rendered" }, children: [] };
      },
    });

    const node = renderBundle({ "image/png": "iVBORw0KGgo=" });

    expect(node.props.className).toBe("service-rendered");
    expect(bundles.length).toBe(1);
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
