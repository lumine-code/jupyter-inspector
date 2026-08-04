const { CompositeDisposable, Disposable } = require("atom");
const { inspectorStore } = require("./inspector-store");

const INSPECTOR_URI = "lumine://jupyter-inspector";

let subscriptions = null;
let provider = null;
let watchEditor = null;

function activate() {
  subscriptions = new CompositeDisposable(
    atom.commands.add("atom-workspace", {
      "jupyter-inspector:toggle": () => toggle(),
      "jupyter-inspector:inspect-under-cursor": () => inspectUnderCursor(),
    }),
    atom.workspace.addOpener((uri) => (uri === INSPECTOR_URI ? createPane() : undefined)),
    new Disposable(() => destroyPane()),
  );
}

function deactivate() {
  subscriptions?.dispose();
  subscriptions = null;
  inspectorStore.reset();
}

function consumeJupyterKernel(jupyterProvider) {
  provider = jupyterProvider;

  // Every method on a wrapper throws once its kernel is gone, so a result left
  // on screen after a shutdown is a panel holding a reference it must not use.
  const removed = provider.onDidRemoveKernel((kernel) => {
    if (inspectorStore.kernel === kernel) {
      inspectorStore.reset();
    }
  });

  return new Disposable(() => {
    removed.dispose();
    provider = null;
    // The result on screen belongs to a kernel nothing can reach any more.
    inspectorStore.reset();
    destroyPane();
  });
}

/**
 * Completion for the expression field. Optional: without it the field is still
 * a real editor, it just offers no suggestions.
 */
function consumeAutocompleteWatchEditor(service) {
  watchEditor = (editor) => service(editor, ["default", "workspace-center"]);
  return new Disposable(() => {
    watchEditor = null;
  });
}

function createPane() {
  const InspectorPane = require("./inspector-pane");
  return new InspectorPane(inspectorStore, (editor) => watchEditor?.(editor));
}

function destroyPane() {
  atom.workspace
    .getPaneItems()
    .find((item) => item.getURI?.() === INSPECTOR_URI)
    ?.destroy();
}

/**
 * Inspect whatever the cursor is on. The expression comes from the provider
 * rather than being parsed here, so it is the same one the REPL would run.
 */
async function inspectUnderCursor() {
  if (!provider) {
    atom.notifications.addWarning("jupyter-inspector", {
      description: "Waiting for `jupyter-repl` to provide a kernel.",
    });
    return;
  }

  const kernel = provider.getActiveKernel();
  if (!kernel) {
    inspectorStore.setError("No kernel running!");
    await show();
    return;
  }

  const expression = provider.getExpressionAtCursor();
  if (!expression) {
    inspectorStore.setError("No code to introspect!");
    await show();
    return;
  }

  inspectorStore.load(kernel, expression);
  await show();
}

// Open without stealing focus: the cursor is still where the user is reading.
async function show() {
  await atom.workspace.open(INSPECTOR_URI, { searchAllPanes: true, activatePane: false });
}

async function toggle() {
  const pane = atom.workspace.paneForURI(INSPECTOR_URI);
  const element = pane?.element;
  const isFocused =
    element &&
    (element.offsetWidth !== 0 || element.offsetHeight !== 0) &&
    element.contains(document.activeElement);

  if (isFocused) {
    atom.workspace.getCenter().activate();
    return;
  }

  const item = await atom.workspace.open(INSPECTOR_URI, { searchAllPanes: true });
  item?.focus?.();
}

module.exports = {
  activate,
  deactivate,
  consumeJupyterKernel,
  consumeAutocompleteWatchEditor,
  INSPECTOR_URI,
};
