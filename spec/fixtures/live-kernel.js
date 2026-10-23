const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

// The store consumes its public request contract, while jupyter_client owns a
// real kernel in a private directory. No user kernelspec or notebook is used.
async function startLiveKernel(python) {
  const parent = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "lumine-inspector-kernel-"));
  if (path.dirname(path.resolve(root)) !== parent)
    throw new Error("Unexpected live-kernel directory; refusing cleanup");
  const env = { ...process.env };
  delete env.CI;
  delete env.PYTHONSTARTUP;
  for (const key of ["JUPYTER_RUNTIME_DIR", "JUPYTER_CONFIG_DIR", "IPYTHONDIR", "TEMP", "TMP"])
    env[key] = root;
  const child = spawn(python, [path.join(__dirname, "live_kernel.py"), root], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  let nextId = 0;
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.on("error", () => {});
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      pending.get(message.id)?.resolve(message);
      pending.delete(message.id);
    } catch (error) {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    }
  });
  child.on("error", (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  const exited = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      for (const request of pending.values())
        request.reject(new Error(`Live kernel bridge exited (${code ?? signal}): ${stderr}`));
      pending.clear();
      resolve({ code, signal });
    });
  });
  const kernel = {
    language: "python",
    generation: 0,
    destroyed: false,
    onDidChangeGeneration: () => ({ dispose() {} }),
    request(specification) {
      const id = ++nextId;
      const done = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ id, ...specification }) + "\n", (error) => {
          if (!error) return;
          pending.delete(id);
          reject(error);
        });
      });
      return { done, dispose() {} };
    },
  };
  async function close() {
    if (kernel.destroyed) return;
    kernel.destroyed = true;
    child.stdin.end();
    let forced = false;
    const timer = setTimeout(() => {
      forced = true;
      if (process.platform === "win32")
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      else child.kill("SIGTERM");
    }, 15000);
    try {
      const result = await exited;
      if (forced || result.code !== 0)
        throw new Error(`Live kernel cleanup failed (${result.code ?? result.signal}): ${stderr}`);
    } finally {
      clearTimeout(timer);
      lines.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  let startupTimer;
  try {
    const ready = await new Promise((resolve, reject) => {
      pending.set(0, { resolve, reject });
      startupTimer = setTimeout(() => reject(new Error("Live kernel startup timed out")), 30000);
    });
    if (ready.status !== "ready") throw new Error(JSON.stringify(ready));
    return { kernel, close, pythonVersion: ready.pythonVersion };
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(startupTimer);
  }
}

module.exports = { startLiveKernel };
