const { Emitter, Disposable } = require("lumine");
const { AutocompleteWatchEditor } = require("../lib/autocomplete");

describe("inspector expression autocomplete service lifecycle", () => {
  let consumer, editor, emitter;
  beforeEach(() => {
    consumer = new AutocompleteWatchEditor();
    emitter = new Emitter();
    editor = { onDidDestroy: (callback) => emitter.on("destroy", callback) };
  });
  afterEach(() => {
    consumer.revoke();
    emitter.dispose();
  });

  it("connects editors created before the service arrives", () => {
    consumer.watchPanelEditor(editor);
    const service = jasmine.createSpy("watch editor").and.returnValue(new Disposable());
    consumer.consume(service);
    expect(service).toHaveBeenCalledWith(editor, ["default", "workspace-center"]);
  });

  it("moves existing editors to a replacement and ignores the old detach", () => {
    const oldWatch = new Disposable(jasmine.createSpy("old registration disposed"));
    const newWatch = new Disposable(jasmine.createSpy("new registration disposed"));
    spyOn(oldWatch, "dispose").and.callThrough();
    spyOn(newWatch, "dispose").and.callThrough();
    const original = consumer.consume(() => oldWatch);
    consumer.watchPanelEditor(editor);
    consumer.consume(() => newWatch);
    expect(oldWatch.dispose).toHaveBeenCalledTimes(1);
    original.dispose();
    expect(consumer.editors.get(editor)).toBe(newWatch);
    expect(newWatch.dispose).not.toHaveBeenCalled();
    emitter.emit("destroy");
    expect(newWatch.dispose).toHaveBeenCalledTimes(1);
    expect(consumer.editors.size).toBe(0);
  });
});
