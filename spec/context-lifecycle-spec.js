const { Disposable } = require("lumine");
const { recordRequest, generationKernel, settle } = require("./request-fixture");
function kernel() {
  return generationKernel({
    language: "python",
    requests: [],
    request(specification) {
      return recordRequest(this, specification);
    },
    onDidBecomeIdle: () => new Disposable(),
  });
}
describe("jupyter-inspector command context ownership", () => {
  let main;
  let editor;
  beforeEach(() => {
    main = require("../lib/main");
    main.initialize();
    main.activate();
    editor = lumine.workspace.buildTextEditor();
    lumine.workspace.getElement().appendChild(editor.element);
  });
  afterEach(() => {
    main.deactivate();
    editor.destroy();
  });
  it("runs against the dispatch editor's kernel instead of the active document's kernel", async () => {
    const active = kernel();
    const target = kernel();
    const lookup = jasmine.createSpy("lookup editor kernel").and.returnValue(target);
    main.consumeJupyterKernel({
      getActiveKernel: () => active,
      getKernelForEditor: lookup,
      onDidChangeKernel: () => new Disposable(),
      onDidRemoveKernel: () => new Disposable(),
    });
    main.consumeJupyterContext({
      getFocusedEditor: (event) =>
        event?.target?.closest("lumine-text-editor")?.getModel() || editor,
      getExpressionAtCursor: () => "chosen",
    });
    editor.setText("chosen");
    editor.selectAll();
    await settle();
    lumine.commands.dispatch(editor.element, "jupyter-inspector:inspect");
    await settle();
    expect(lookup).toHaveBeenCalledWith(editor);
    expect(main.deserializeInspectorPane().component.session.kernel).toBe(target);
    expect(active.requests.length).toBe(0);
  });
  it("keeps the new context when an older edge for the same service object detaches", async () => {
    const target = kernel();
    const lookup = jasmine.createSpy("lookup editor kernel").and.returnValue(target);
    main.consumeJupyterKernel({
      getActiveKernel: () => null,
      getKernelForEditor: lookup,
      onDidChangeKernel: () => new Disposable(),
      onDidRemoveKernel: () => new Disposable(),
    });
    const service = { getFocusedEditor: () => editor, getExpressionAtCursor: () => "chosen" };
    const old = main.consumeJupyterContext(service);
    const current = main.consumeJupyterContext(service);
    editor.setText("chosen");
    editor.selectAll();
    await settle();
    old.dispose();
    lumine.commands.dispatch(editor.element, "jupyter-inspector:inspect");
    await settle();
    expect(lookup).toHaveBeenCalledWith(editor);
    expect(target.requests.length).toBeGreaterThan(0);
    current.dispose();
  });
});
