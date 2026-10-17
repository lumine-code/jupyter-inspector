describe("Inspector pane opening ownership", () => {
  let main;

  beforeEach(() => {
    main = require("../lib/main");
    main.initialize();
    main.activate();
  });

  afterEach(() => main.deactivate());

  it("does not focus a pane when opening finishes after deactivation", async () => {
    let finishOpen;
    const focus = jasmine.createSpy("focus pane");
    spyOn(lumine.workspace, "open").and.returnValue(
      new Promise((resolve) => (finishOpen = resolve)),
    );

    lumine.commands.dispatch(lumine.workspace.getElement(), "jupyter-inspector:toggle-focus");
    expect(lumine.workspace.open).toHaveBeenCalled();
    main.deactivate();
    main.initialize();
    main.activate();
    finishOpen({ focus });
    await Promise.resolve();
    await Promise.resolve();

    expect(focus).not.toHaveBeenCalled();
  });
});
