const { Disposable } = require("lumine");

describe("inspector service replacement", () => {
  let main;
  beforeEach(() => {
    main = require("../lib/main");
    main.initialize();
    main.activate();
  });
  afterEach(() => main.deactivate());

  function provider() {
    return {
      getActiveKernel: () => null,
      onDidChangeKernel: () => new Disposable(),
      onDidRemoveKernel: () => new Disposable(),
    };
  }

  it("keeps the newer kernel provider when the old one detaches", async () => {
    const pane = main.deserializeInspectorPane();
    const original = main.consumeJupyterKernel(provider());
    const next = provider();
    const replacement = main.consumeJupyterKernel(next);
    await Promise.resolve();
    original.dispose();
    expect(pane.destroyed).not.toBe(true);
    expect(pane.component.session.provider).toBe(next);
    replacement.dispose();
    expect(pane.destroyed).toBe(true);
  });

  it("keeps the newer output renderer when the old one detaches", () => {
    const renderer = require("../lib/output-renderer");
    const original = main.consumeJupyterOutput({});
    const next = {};
    const replacement = main.consumeJupyterOutput(next);
    original.dispose();
    expect(renderer.get()).toBe(next);
    replacement.dispose();
    expect(renderer.get()).toBeNull();
  });
});
