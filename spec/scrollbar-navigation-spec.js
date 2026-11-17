const path = require("node:path");
const { Emitter } = require("lumine");
const { ipcRenderer } = require("electron");
const InspectorPane = require("../lib/inspector-pane");

describe("Inspector scrollbar navigation", () => {
  let pane, events, store, controller, bindings;

  beforeEach(async () => {
    jasmine.useRealClock();
    bindings = lumine.keymaps.add(
      "inspector-scrollbar-keyboard-spec",
      lumine.keymaps.readKeymap(path.join(__dirname, "../keymaps/main.json")),
    );
    events = new Emitter();
    store = {
      expression: "value",
      text: Array.from({ length: 80 }, (_, index) => `Help line ${index}`).join("\n"),
      loading: false,
      error: null,
      setExpression() {},
      loadExpression() {},
      onDidUpdate: (callback) => events.on("update", callback),
    };
    pane = new InspectorPane({
      storeFor: () => store,
      onDidChangeCurrentKernel: () => ({ dispose() {} }),
    });
    const workspaceElement = lumine.views.getView(lumine.workspace);
    workspaceElement.append(pane.element);
    jasmine.attachToDOM(workspaceElement);
    const body = pane.element.querySelector(".inspector-body");
    body.style.cssText = "height:64px;overflow:auto;line-height:20px;white-space:pre";
    controller = lumine.scrollbars.attach(body, {
      kind: "panel",
      layout: "overlay",
      policy: "hover",
      focusOwner: pane.element,
    });
    await window.waitForFrames(() => controller.publicGeometry?.canScrollVertically, {
      description: "the inspection body to have measured overflowing help text",
    });
  });

  afterEach(() => {
    controller?.dispose();
    pane?.destroy();
    bindings?.dispose();
    events?.dispose();
  });

  async function focusForKeyboard(element) {
    await ipcRenderer.invoke("lumine:window", "focus");
    await window.waitForFrames(() => document.hasFocus(), {
      description: "trusted Inspector keyboard input to belong to the spec window",
    });
    element.focus({ preventScroll: true });
    expect(
      document.activeElement === element || element.contains(document.activeElement),
    ).toBeTrue();
  }

  async function key(keyCode) {
    for (const type of ["keyDown", "keyUp"])
      await ipcRenderer.invoke("lumine:window", "sendInputEvent", { type, keyCode });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  for (const [command, direction] of [
    ["jupyter-inspector:scroll-up", -1],
    ["jupyter-inspector:scroll-down", 1],
  ]) {
    it(`reveals only the body for ${command}, including its unchanged boundary`, () => {
      const body = pane.element.querySelector(".inspector-body");
      const reveal = spyOn(lumine.scrollbars, "reveal").and.callThrough();
      body.scrollTop = 100;
      const before = body.scrollTop;

      lumine.commands.dispatch(body, command);

      expect(body.scrollTop).toBe(before + direction * 60);
      expect(reveal).toHaveBeenCalledOnceWith(body);
      expect(controller.activity.active).toBeTrue();
      expect(controller.layer.classList.contains("is-revealed")).toBeTrue();

      body.scrollTop = direction < 0 ? 0 : body.scrollHeight - body.clientHeight;
      const boundary = body.scrollTop;
      controller.activity.clear();
      reveal.calls.reset();
      lumine.commands.dispatch(body, command);

      expect(body.scrollTop).toBe(boundary);
      expect(reveal).toHaveBeenCalledOnceWith(body);
      expect(controller.activity.active).toBeTrue();
    });
  }

  it("uses the shipped body arrow shortcuts without scrolling from the expression editor", async () => {
    const body = pane.element.querySelector(".inspector-body");
    await focusForKeyboard(body);
    const reveal = spyOn(lumine.scrollbars, "reveal").and.callThrough();
    const scroll = spyOn(pane, "scroll").and.callThrough();
    body.scrollTop = 0;

    await key("Up");
    expect(body.scrollTop).toBe(0);
    expect(reveal).toHaveBeenCalledOnceWith(body);
    expect(controller.activity.active).toBeTrue();

    reveal.calls.reset();
    scroll.calls.reset();
    await key("Down");
    expect(body.scrollTop).toBe(60);
    expect(reveal).toHaveBeenCalledOnceWith(body);
    expect(scroll).toHaveBeenCalledTimes(1);

    const expression = pane.component.refs.expression.editor.element;
    await focusForKeyboard(expression);
    reveal.calls.reset();
    scroll.calls.reset();
    await key("Down");
    await key("Up");
    expect(body.scrollTop).toBe(60);
    expect(scroll).not.toHaveBeenCalled();
    expect(reveal.calls.allArgs().some(([target]) => target === body)).toBeFalse();
  });

  it("keeps result rendering, restored offsets and wheel/scroll events from renewing activity", async () => {
    const body = pane.element.querySelector(".inspector-body");
    lumine.commands.dispatch(body, "jupyter-inspector:scroll-down");
    const deadline = controller.activity.deadline;
    const reveal = spyOn(lumine.scrollbars, "reveal").and.callThrough();
    store.text += "\nNew inspection text";
    events.emit("update");
    body.scrollTop = 200;
    body.dispatchEvent(new Event("scroll"));
    body.dispatchEvent(new WheelEvent("wheel", { deltaY: 20, bubbles: true }));
    await pane.component.update();

    expect(reveal).not.toHaveBeenCalled();
    expect(controller.activity.deadline).toBe(deadline);
  });

  it("does not signal an empty, missing or destroyed inspection body", async () => {
    store = null;
    await pane.component.update();
    const body = pane.element.querySelector(".inspector-body");
    expect(body.classList.contains("panel-empty-state")).toBeTrue();
    const reveal = spyOn(lumine.scrollbars, "reveal");
    lumine.commands.dispatch(body, "jupyter-inspector:scroll-down");
    expect(reveal).not.toHaveBeenCalled();

    body.remove();
    pane.scroll(null, 1);
    expect(reveal).not.toHaveBeenCalled();
    pane.element.append(body);
    pane.destroy();
    pane.scroll(null, -1);
    expect(reveal).not.toHaveBeenCalled();
  });
});
