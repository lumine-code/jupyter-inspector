const { spawnSync } = require("node:child_process");
const path = require("node:path");

describe("Inspector generated Python namespace", () => {
  it("keeps an existing helper and isolates statement locals while publishing its owned target", async () => {
    for (const method of ["openPath", "openExternal", "openApplication", "showItemInFolder"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    const python =
      process.env.LUMINE_TEST_PYTHON || (process.platform === "win32" ? null : "python3");
    if (!python) return pending("Set LUMINE_TEST_PYTHON to an owned Python executable on Windows.");
    const pack = await lumine.packages.activatePackage("jupyter-inspector");
    const { buildPythonResultInspectorCode } = require(path.join(pack.path, "lib/inspector-store"));
    const code = buildPythonResultInspectorCode(
      "temporary = answer + 1\ntemporary",
      "_owned_result",
    );
    const script = `import base64, builtins, sys
old = lambda: 'owned original helper'
for runtime in (builtins,builtins.__dict__):
    namespace={'answer':42,'exec':'owned ordinary value','_jupyter_inspector_eval':old,'__builtins__':runtime}
    before=set(namespace)
    exec(compile(base64.b64decode(sys.argv[1]).decode('utf-8'),'<owned-inspector>','exec'),namespace)
    assert namespace.get('_jupyter_inspector_eval') is old, 'existing private user helper was changed'
    assert namespace['_owned_result']==43
    assert namespace['__builtins__'] is runtime
    assert set(namespace)==before|{'_owned_result'}, 'temporary statement names leaked'
print('completed owned namespace control')
`;
    const result = spawnSync(python, ["-S", "-c", script, Buffer.from(code).toString("base64")], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    expect(result.error).withContext(result.error?.message).toBeUndefined();
    expect(result.status).withContext(result.stderr).toBe(0);
    expect(result.stdout).toContain("completed owned namespace control");
    await lumine.packages.deactivatePackage("jupyter-inspector");
  });
});
