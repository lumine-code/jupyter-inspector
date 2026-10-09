const { recordRequest, settle } = require("./request-fixture");
const etch = require("@lumine-code/etch");
const { Inspector, renderResultText } = require("../lib/inspector");
const outputRenderer = require("../lib/output-renderer");
const { InspectorStore, buildPythonResultInspectorCode } = require("../lib/inspector-store");
const InspectorSession = require("../lib/inspector-session");

// The `jupyter.kernel` surface the session consumes, driven by hand.
function fakeProvider() {
  const callbacks = {
    changed: [],
    removed: [],
  };
  return {
    active: null,
    getActiveKernel() {
      return this.active;
    },
    onDidChangeKernel(callback) {
      callbacks.changed.push(callback);
      return {
        dispose() {},
      };
    },
    onDidRemoveKernel(callback) {
      callbacks.removed.push(callback);
      return {
        dispose() {},
      };
    },
    setActive(kernel) {
      this.active = kernel;
      callbacks.changed.slice().forEach((callback) => callback(kernel));
    },
    remove(kernel) {
      if (this.active === kernel) this.setActive(null);
      callbacks.removed.slice().forEach((callback) => callback(kernel));
    },
  };
}

// A session already bound to one store, for panel specs.
function fakeSession(store) {
  return {
    storeFor: () => store,
    onDidChangeCurrentKernel: () => ({
      dispose() {},
    }),
  };
}

// This panel used to live inside jupyter-repl and reach into its store. It now
// sees a kernel only as `jupyter.kernel` hands it over, so the fake below
// offers exactly that surface — `inspect` returning a promise, `executeWatch`
// taking a callback — and nothing else.

const flush = (component) => etch.updateSync(component);
function fakeKernel(overrides = {}) {
  return {
    language: "python",
    displayName: "Python 3",
    grammar: {
      name: "Python",
      scopeName: "source.python",
    },
    executed: [],
    inspected: [],
    inspectReply: () =>
      Promise.resolve({
        found: true,
        data: {
          "text/plain": "docs",
        },
      }),
    request(specification) {
      return recordRequest(this, specification);
    },
    ...overrides,
    generation: 0,
    onDidChangeGeneration: () => ({
      dispose() {},
    }),
  };
}
describe("inspector store", () => {
  it("refuses an empty expression", async () => {
    const store = new InspectorStore(fakeKernel());
    store.loadExpression("   ");
    await settle();
    expect(store.error).toBe("No code to introspect!");
  });
  it("asks a non-Python kernel about the expression as written", async () => {
    const kernel = fakeKernel({
      language: "julia",
      generation: 0,
      onDidChangeGeneration: () => ({
        dispose() {},
      }),
    });
    const store = new InspectorStore(kernel);
    store.loadExpression("foo");
    await settle();
    expect(kernel.inspected).toEqual([
      {
        expression: "foo",
        cursorPos: 3,
      },
    ]);
    expect(kernel.executed).toEqual([]);
  });
  it("evaluates a Python expression to a name before inspecting it", async () => {
    const kernel = fakeKernel();
    const store = new InspectorStore(kernel);
    store.loadExpression("df.head()");

    // The expression cannot be inspected directly, so it is bound first.
    await settle();
    expect(kernel.executed.length).toBe(1);
    await settle();
    expect(kernel.executed[0]).toContain("def _jupyter_inspector_eval():");
    const literal = JSON.stringify("df.head()");
    const embeddedLiteral = JSON.stringify(literal).slice(1, -1);
    expect([literal, embeddedLiteral].some((value) => kernel.executed[0].includes(value))).toBe(
      true,
    );
    expect(kernel.inspected).toEqual([]);
    kernel.lastOnResults({
      stream: "status",
      data: "ok",
    });
    await settle();
    expect(kernel.inspected[0].expression).toMatch(/^__jupyter_inspector_result_[A-Za-z0-9_]+$/);
  });
  it("generates Python whose identifiers are legal", async () => {
    const code = buildPythonResultInspectorCode("df", "__jupyter_inspector_result_1");

    // A hyphen here is a SyntaxError, and this code came from a package rename.
    for (const name of code.match(/_{1,2}jupyter[A-Za-z0-9_-]*/g) || []) {
      expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
    expect(code).not.toContain("jupyter-");
  });
  it("asks a Python kernel about a name directly", async () => {
    const kernel = fakeKernel();
    const store = new InspectorStore(kernel);
    store.loadExpression("np.array");
    await settle();
    await Promise.resolve();

    // Nothing to evaluate: a dotted name resolves as written, and the answer's
    // header then carries the real name, not a bound temporary.
    expect(kernel.executed).toEqual([]);
    await settle();
    expect(kernel.inspected).toEqual([
      {
        expression: "np.array",
        cursorPos: 8,
      },
    ]);
    expect(store.text).toBe("docs");
  });
  it("swaps the temporary's name back for the expression", async () => {
    const kernel = fakeKernel();
    const store = new InspectorStore(kernel);
    store.loadExpression("make()");
    await settle();
    spyOn(kernel, "inspectReply").and.callFake((name) => {
      return Promise.resolve({
        found: true,
        data: {
          "text/plain": `Signature: ${name}(x)`,
        },
      });
    });
    await settle();
    kernel.lastOnResults({
      stream: "status",
      data: "ok",
    });
    await settle();
    await Promise.resolve();
    await Promise.resolve();
    const inspectedName = kernel.inspected[0].expression;
    expect(inspectedName).toMatch(/^__jupyter_inspector_result_[A-Za-z0-9_]+$/);
    expect(store.text).toBe("Signature: make()(x)");
  });
  it("surfaces an execution error instead of a result", async () => {
    const kernel = fakeKernel();
    const store = new InspectorStore(kernel);
    store.loadExpression("boom()");
    await settle();
    kernel.lastOnResults({
      output_type: "error",
      ename: "NameError",
      evalue: "boom",
      traceback: [],
    });
    await settle();
    expect(store.error).toBe("NameError: boom");
    expect(store.text).toBe(null);
  });
  it("announces each change", async () => {
    const store = new InspectorStore(fakeKernel());
    let calls = 0;
    const subscription = store.onDidUpdate(() => calls++);
    store.setExpression("df");
    await settle();
    store.setError("nope");
    await settle();
    expect(calls).toBe(2);
    subscription.dispose();
    await settle();
  });
  it("shows a rejected inspection as an error and ends loading", async () => {
    const store = new InspectorStore(
      fakeKernel({
        inspectReply: () => Promise.reject(new Error("Kernel restarted")),
      }),
    );
    store.loadExpression("value");
    await settle();
    await Promise.resolve();
    expect(store.error).toBe("Kernel restarted");
    expect(store.loading).toBe(false);
    store.destroy();
    await settle();
  });
  it("ignores an older inspection after a newer empty request", async () => {
    let finish;
    const store = new InspectorStore(
      fakeKernel({
        inspectReply: () => new Promise((resolve) => (finish = resolve)),
      }),
    );
    store.loadExpression("value");
    await settle();
    store.loadExpression("");
    await settle();
    finish({
      found: true,
      data: {
        "text/plain": "old docs",
      },
    });
    await settle();
    await Promise.resolve();
    expect(store.error).toBe("No code to introspect!");
    expect(store.text).toBeNull();
    store.destroy();
    await settle();
  });
  it("cleans a superseded evaluation once across all of its late messages", async () => {
    const kernel = fakeKernel();
    const store = new InspectorStore(kernel);
    store.loadExpression("make()");
    await settle();
    const earlier = kernel.lastOnResults;
    store.loadExpression("other");
    await settle();
    earlier({
      output_type: "stream",
      text: "late",
    });
    await settle();
    earlier({
      stream: "status",
      data: "ok",
    });
    await settle();
    earlier({
      output_type: "status",
      execution_state: "idle",
    });
    await settle();
    expect(kernel.executed.filter((code) => code.startsWith("globals().pop")).length).toBe(1);
    store.destroy();
    await settle();
  });
  it("ignores a revoked wrapper's rejected cleanup after destruction", async () => {
    const kernel = fakeKernel();
    const store = new InspectorStore(kernel);
    store.loadExpression("make()");
    kernel.destroyed = true;
    store.destroy();
    await settle();
    expect(kernel.executed.length).toBe(1);
  });
  it("cleans a destroyed store's late result through its original live kernel", async () => {
    const kernel = fakeKernel();
    const replacement = fakeKernel();
    const store = new InspectorStore(kernel);
    store.loadExpression("make()");
    await settle();
    const deliver = kernel.lastOnResults;
    store.destroy();
    await settle();
    store.kernel = replacement;
    deliver({
      stream: "status",
      data: "ok",
    });
    await settle();
    deliver({
      output_type: "status",
      execution_state: "idle",
    });
    await settle();
    expect(kernel.executed.filter((code) => code.startsWith("globals().pop")).length).toBe(1);
    expect(replacement.executed).toEqual([]);
    expect(store.text).toBeNull();
  });
  it("keeps independent stores' temporary names distinct on a shared kernel", async () => {
    const kernel = fakeKernel();
    const first = new InspectorStore(kernel);
    const second = new InspectorStore(kernel);
    first.loadExpression("first()");
    await settle();
    const firstReply = kernel.lastOnResults;
    second.loadExpression("second()");
    await settle();
    const secondReply = kernel.lastOnResults;
    firstReply({
      stream: "status",
      data: "ok",
    });
    await settle();
    secondReply({
      stream: "status",
      data: "ok",
    });
    await settle();
    const names = kernel.inspected.map((request) => request.expression);
    expect(names.length).toBe(2);
    expect(names[0]).not.toBe(names[1]);
    expect(names.every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))).toBe(true);
    first.destroy();
    await settle();
    second.destroy();
    await settle();
  });
  it("cleans the temporary when its inspection rejects", async () => {
    const kernel = fakeKernel({
      inspectReply: () => Promise.reject(new Error("Inspect failed")),
    });
    const store = new InspectorStore(kernel);
    store.loadExpression("make()");
    await settle();
    kernel.lastOnResults({
      stream: "status",
      data: "ok",
    });
    await settle();
    await Promise.resolve();
    expect(store.error).toBe("Inspect failed");
    expect(kernel.executed.filter((code) => code.startsWith("globals().pop")).length).toBe(1);
    store.destroy();
    await settle();
  });
});
describe("inspector session", () => {
  it("keeps one store per kernel and swaps with the active one", async () => {
    const session = new InspectorSession();
    const provider = fakeProvider();
    const a = fakeKernel({
      displayName: "A",
    });
    const b = fakeKernel({
      displayName: "B",
    });
    provider.active = a;
    session.setProvider(provider);
    await settle();
    session.storeFor().setText("docs of A");
    await settle();
    provider.setActive(b);
    await settle();
    expect(session.storeFor().text).toBe(null);
    session.storeFor().setText("docs of B");

    // Coming back to A shows what A remembered.
    await settle();
    provider.setActive(a);
    await settle();
    expect(session.storeFor().text).toBe("docs of A");
    session.destroy();
    await settle();
  });
  it("drops a kernel store when the kernel goes", async () => {
    const session = new InspectorSession();
    const provider = fakeProvider();
    const a = fakeKernel();
    provider.active = a;
    session.setProvider(provider);
    await settle();
    session.storeFor().setText("gone soon");
    await settle();
    provider.remove(a);
    await settle();
    expect(session.kernel).toBe(null);
    expect(session.stores.size).toBe(0);
    session.destroy();
    await settle();
  });
  it("drops the previous provider's stores and ignores its late events", async () => {
    const session = new InspectorSession();
    const first = fakeProvider();
    const second = fakeProvider();
    first.active = fakeKernel();
    second.active = fakeKernel();
    session.setProvider(first);
    await settle();
    const originalStore = session.storeFor();
    session.setProvider(second);
    await settle();
    first.setActive(fakeKernel());
    await settle();
    expect(originalStore.destroyed).toBe(true);
    expect(session.kernel).toBe(second.active);
    expect(session.stores.size).toBe(0);
    session.destroy();
    await settle();
  });
});
describe("inspector result text rendering", () => {
  afterEach(() => outputRenderer.set(null));
  it("colours and truncates through jupyter.output when the service is there", async () => {
    outputRenderer.set({
      truncateOutput: (text) => ({
        text: text.slice(0, 4),
        truncated: true,
      }),
      ansiNodes: (text) => `ansi(${text})`,
    });
    await settle();
    const node = renderResultText("Signature: np.array");
    expect(node.props.className).toBe("inspector-text");
    expect(node.children[0].text).toBe("ansi(Sign)");
    expect(node.children[1].props.className).toBe("output-truncated");
  });
  it("strips colour escapes without the service", async () => {
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
    store = new InspectorStore(fakeKernel());
    component = new Inspector({
      session: fakeSession(store),
      watchEditor: () => {},
    });
    flush(component);
  });
  afterEach(() => {
    component?.destroy();
    component = null;
  });
  it("says nothing is loaded before anything is", async () => {
    expect(component.element.querySelector(".inspector-message").textContent).toContain(
      "No inspection loaded",
    );
  });
  it("offers an expression editor", async () => {
    expect(component.element.querySelector("lumine-text-editor.inspector-expression")).toBeTruthy();
  });
  it("shows a result once one arrives", async () => {
    store.setText("the docstring");
    await settle();
    flush(component);
    await settle();
    expect(component.element.querySelector(".inspector-result").textContent).toContain(
      "the docstring",
    );
  });
  it("shows an error in place of a result", async () => {
    store.setError("No code to introspect!");
    await settle();
    flush(component);
    await settle();
    expect(component.element.querySelector(".text-error").textContent).toBe(
      "No code to introspect!",
    );
  });
  it("says no kernel is running when none is", async () => {
    const bare = new Inspector({
      session: fakeSession(null),
      watchEditor: () => {},
    });
    flush(bare);
    await settle();
    expect(bare.element.querySelector("ul.background-message").textContent).toContain(
      "No kernel running",
    );
    expect(bare.element.querySelector("lumine-text-editor")).toBe(null);
    bare.destroy();
    await settle();
  });
});
describe("inspector pane", () => {
  const InspectorPane = require("../lib/inspector-pane");

  // Losing the kernel service destroys the item directly rather than through
  // `pane.destroyItem`, and a pane only drops an item that tells it so.
  it("leaves no tab behind when destroyed directly", async () => {
    const pane = new InspectorPane(fakeSession(new InspectorStore(fakeKernel())), () => {});
    const workspacePane = lumine.workspace.getCenter().getActivePane();
    workspacePane.addItem(pane);
    await settle();
    expect(workspacePane.getItems()).toContain(pane);
    pane.destroy();
    await settle();
    expect(workspacePane.getItems()).not.toContain(pane);
  });
  it("survives being destroyed twice", async () => {
    const pane = new InspectorPane(fakeSession(new InspectorStore(fakeKernel())), () => {});
    pane.destroy();
    await settle();
    expect(() => pane.destroy()).not.toThrow();
  });
});
