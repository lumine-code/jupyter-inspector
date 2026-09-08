const path = require("path");
const manifest = require("../package.json");
const main = require("../lib/main");
const InspectorSession = require("../lib/inspector-session");
const InspectorPane = require("../lib/inspector-pane");

const DESERIALIZER = "jupyter-inspector/InspectorPane";
const STATE = { deserializer: DESERIALIZER };

function fakeProvider() {
  return {
    getActiveKernel: () => null,
    onDidChangeKernel: () => ({ dispose() {} }),
    onDidRemoveKernel: () => ({ dispose() {} }),
  };
}

describe("jupyter inspector pane persistence", () => {
  let loadedPackage = null;

  afterEach(async () => {
    if (loadedPackage && lumine.packages.isPackageActive(loadedPackage.name)) {
      await lumine.packages.deactivatePackage(loadedPackage.name);
    } else {
      main.deactivate();
    }
    if (loadedPackage && lumine.packages.isPackageLoaded(loadedPackage.name)) {
      lumine.packages.unloadPackage(loadedPackage.name);
    }
    loadedPackage = null;
  });

  it("declares the namespaced deserializer and serializes only its identity", () => {
    expect(manifest.deserializers).toEqual({
      [DESERIALIZER]: "deserializeInspectorPane",
    });

    main.initialize();
    const restored = main.deserializeInspectorPane();

    expect(restored.serialize()).toEqual(STATE);
  });

  it("round-trips through the manifest-registered proxy before activation", () => {
    const sourceSession = new InspectorSession();
    const source = new InspectorPane(sourceSession, () => {});
    const state = source.serialize();
    source.destroy();
    sourceSession.destroy();

    spyOn(lumine.packages, "hasActivatedInitialPackages").and.returnValue(false);
    loadedPackage = lumine.packages.loadPackage(path.resolve(__dirname, ".."));

    const restored = lumine.deserializers.deserialize(state);

    expect(restored).toBeTruthy();
    expect(restored.serialize()).toEqual(state);
    expect(lumine.deserializers.deserialize(restored.serialize())).toBe(restored);
    expect(loadedPackage.mainInitialized).toBe(true);
    expect(loadedPackage.mainActivated).toBe(false);
  });

  it("keeps the restored singleton through activation and recreates it after close", async () => {
    main.initialize();
    const restored = main.deserializeInspectorPane();

    main.activate();
    const opened = await lumine.workspace.open(main.INSPECTOR_URI, { searchAllPanes: true });

    expect(opened).toBe(restored);
    expect(
      lumine.workspace.getPaneItems().filter((item) => item.getURI?.() === main.INSPECTOR_URI)
        .length,
    ).toBe(1);

    restored.destroy();
    const reopened = await lumine.workspace.open(main.INSPECTOR_URI, { searchAllPanes: true });
    expect(reopened).not.toBe(restored);
  });

  it("connects a late kernel provider to the restored pane's existing session", () => {
    main.initialize();
    const restored = main.deserializeInspectorPane();
    const component = restored.component;
    expect(component.session.provider).toBe(null);

    main.activate();
    const provider = fakeProvider();
    const service = main.consumeJupyterKernel(provider);

    expect(restored.component).toBe(component);
    expect(component.session.provider).toBe(provider);
    service.dispose();
  });
});
