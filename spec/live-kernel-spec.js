const path = require("node:path");
const { startLiveKernel } = require("./fixtures/live-kernel");

function waitForResult(store, expression) {
  return new Promise((resolve, reject) => {
    let started = false;
    const timer = setTimeout(() => {
      subscription.dispose();
      reject(new Error(`Inspector did not finish: ${expression}`));
    }, 20000);
    const subscription = store.onDidUpdate(() => {
      if (store.loading) started = true;
      if (
        !started ||
        store.loading ||
        store.expression !== expression ||
        (!store.text && !store.error)
      )
        return;
      clearTimeout(timer);
      subscription.dispose();
      resolve();
    });
    store.loadExpression(expression);
  });
}

describe("Inspector with a real Python kernel", () => {
  it("inspects scientific values and releases temporary names in a live session", async () => {
    if (process.env.LUMINE_TEST_LIVE_PYTHON !== "true")
      return pending("Live kernel validation requires explicit disposable-runner opt-in.");
    const python = process.env.LUMINE_TEST_PYTHON;
    if (!python) throw new Error("Live kernel validation requires LUMINE_TEST_PYTHON.");
    const pack = await lumine.packages.activatePackage("jupyter-inspector");
    const { InspectorStore } = require(path.join(pack.path, "lib/inspector-store"));
    const live = await startLiveKernel(python);
    const store = new InspectorStore(live.kernel);
    const execute = (code) => live.kernel.request({ type: "execute", code }).done;
    try {
      if (process.env.LUMINE_TEST_PYTHON_VERSION)
        expect(live.pythonVersion).toBe(process.env.LUMINE_TEST_PYTHON_VERSION);
      const setup = await execute(`
import numpy as np
import pandas as pd
import pyarrow as pa
frame = pd.DataFrame({"value": np.arange(4)})
arrow = pa.Table.from_pandas(frame)
assert arrow.column("value").to_pylist() == [0, 1, 2, 3]
`);
      expect(setup.status).withContext(JSON.stringify(setup.error)).toBe("ok");

      await waitForResult(store, "pd.DataFrame");
      expect(store.error).toBeNull();
      expect(store.text).toContain("DataFrame");

      await waitForResult(store, "np.arange(3)");
      expect(store.error).toBeNull();
      expect(store.text).toContain("ndarray");
      expect(store.text).not.toContain("__jupyter_inspector_result_");

      await waitForResult(store, "scratch = frame.head(2)\npa.Table.from_pandas(scratch)");
      expect(store.error).toBeNull();
      expect(store.text).toContain("Table");

      await waitForResult(store, "1 / 0");
      expect(store.error).toContain("ZeroDivisionError");
      expect(store.text).toBeNull();

      const namespace = await execute(`
assert "scratch" not in globals()
assert "_jupyter_inspector_eval" not in globals()
assert not any(name.startswith("__jupyter_inspector_result_") for name in globals())
assert frame["value"].tolist() == [0, 1, 2, 3]
`);
      expect(namespace.status).withContext(JSON.stringify(namespace.error)).toBe("ok");
    } finally {
      store.destroy();
      await live.close();
      await lumine.packages.deactivatePackage("jupyter-inspector");
    }
  }, 90000);
});
