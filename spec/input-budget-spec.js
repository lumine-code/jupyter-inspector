const { Emitter, TextBuffer } = require("lumine");
const etch = require("@lumine-code/etch");
function giantSource() {
  let source = TextBuffer.createTextSnapshot("x".repeat(32768));
  while (source.canMaterialize()) source = source.replace(source.length, source.length, source);
  return source;
}
function kernel() {
  const requests = [];
  return {
    language: "javascript",
    generation: 1,
    requests,
    onDidChangeGeneration: () => ({ dispose() {} }),
    request: jasmine.createSpy("request").and.callFake((specification) => {
      let resolve;
      const request = {
        specification,
        done: new Promise((finish) => {
          resolve = finish;
        }),
        dispose: jasmine.createSpy("dispose"),
        resolve: (value) => resolve(value),
      };
      requests.push(request);
      return request;
    }),
  };
}

describe("Inspector source-backed input budget", () => {
  let panel,
    stores = [],
    events;
  beforeEach(() => {
    jasmine.useRealClock();
    events = new Emitter();
  });
  afterEach(async () => {
    if (panel) await panel.destroy();
    for (const store of stores) store.destroy();
    stores = [];
    events.dispose();
    panel = null;
  });
  function storeFor(target) {
    const { InspectorStore } = require("../lib/inspector-store");
    const store = new InspectorStore(target);
    stores.push(store);
    return store;
  }
  function mount(active) {
    const { Inspector } = require("../lib/inspector");
    panel = new Inspector({
      session: {
        storeFor: () => active.value,
        onDidChangeCurrentKernel: (callback) => events.on("kernel", callback),
      },
    });
    return panel.refs.expression.editor;
  }

  it("cancels pending work and blocks both confirm and refresh without reading a giant draft", async () => {
    const target = kernel(),
      store = storeFor(target),
      editor = mount({ value: store });
    store.loadExpression("previous");
    const source = giantSource(),
      original = editor.getText;
    spyOn(editor, "getText").and.callFake(() => {
      if (editor.getBuffer().getLength() > 65536) throw new Error("oversized expression was read");
      return original.call(editor);
    });
    editor.getBuffer().setText(source);
    etch.updateSync(panel);
    expect(target.requests[0].dispose).toHaveBeenCalled();
    expect(store.expressionSource.equals(source)).toBeTrue();
    expect(panel.element.querySelector(".input-budget-error").hidden).toBeFalse();
    store.refresh();
    lumine.commands.dispatch(editor.element, "core:confirm");
    expect(target.request).toHaveBeenCalledTimes(1);
    target.requests[0].resolve({
      status: "ok",
      data: { found: true, data: { "text/plain": "stale" } },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.text).toBeNull();
    expect(store.error).toContain("65536");
    editor.setText("current");
    etch.updateSync(panel);
    expect(store.expression).toBe("current");
    expect(panel.element.querySelector(".input-budget-error").hidden).toBeTrue();
    lumine.commands.dispatch(editor.element, "core:confirm");
    expect(target.request).toHaveBeenCalledTimes(2);
    expect(target.requests[1].specification.code).toBe("current");
  });

  it("does not replace the whole input during a source-backed keystroke echo", () => {
    const store = storeFor(kernel());
    store.setExpression("hello");
    const editor = mount({ value: store });
    const change = jasmine.createSpy("buffer change");
    const subscription = editor.getBuffer().onWillChange(change);
    editor.setCursorBufferPosition([0, 2]);
    editor.insertText("X");
    etch.updateSync(panel);
    expect(change).toHaveBeenCalledTimes(1);
    expect(editor.getCursorBufferPosition().serialize()).toEqual([0, 3]);
    editor.undo();
    etch.updateSync(panel);
    expect(editor.getText()).toBe("hello");
    subscription.dispose();
  });

  it("retains independent complete drafts across kernel switches and panel recreation", async () => {
    const first = storeFor(kernel()),
      second = storeFor(kernel()),
      active = { value: first };
    let editor = mount(active);
    const source = giantSource();
    editor.getBuffer().setText(source);
    etch.updateSync(panel);
    second.setExpression("second");
    active.value = second;
    events.emit("kernel");
    etch.updateSync(panel);
    editor = panel.refs.expression.editor;
    expect(editor.getText()).toBe("second");
    active.value = first;
    events.emit("kernel");
    etch.updateSync(panel);
    expect(panel.refs.expression.editor.getBuffer().getTextSnapshot().equals(source)).toBeTrue();
    await panel.destroy();
    panel = null;
    editor = mount(active);
    expect(editor.getBuffer().getTextSnapshot().equals(source)).toBeTrue();
    expect(panel.element.querySelector(".input-budget-error").hidden).toBeFalse();
  });

  it("preflights explicit expression snapshots and generated Python before string expansion", () => {
    const target = kernel(),
      store = storeFor(target),
      source = giantSource();
    store.loadExpression(source);
    store.refresh();
    expect(store.expressionSource.equals(source)).toBeTrue();
    expect(target.request).not.toHaveBeenCalled();
    expect(() => store.expression).toThrowError(/65536/);
    const { buildPythonResultInspectorCode } = require("../lib/inspector-store");
    expect(() => buildPythonResultInspectorCode("x".repeat(65537), "result")).toThrowError(/65536/);
  });

  it("rejects excessive result-name expansion before allocating the expanded presentation", async () => {
    const target = kernel(),
      store = storeFor(target);
    const request = store._inspectExpression(store._requestId, "temp", 4, {
      from: "temp",
      to: "x".repeat(65536),
    });
    target.requests[0].resolve({
      status: "ok",
      data: { found: true, data: { "text/plain": "temp".repeat(1000) } },
    });
    await request;
    expect(store.text).toBeNull();
    expect(store.error).toContain("presentation budget");
  });
});
