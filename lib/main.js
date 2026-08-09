const { CompositeDisposable, Disposable } = require("lumine");
const InspectorSession = require("./inspector-session");

const INSPECTOR_URI = "lumine://jupyter-inspector";

// One session for the package: the active kernel and a store per kernel, so
// every kernel remembers its last inspection — the jupyter-variables
// lifecycle.
const session = new InspectorSession();

let subscriptions = null;
let watchEditor = null;

function activate() {
  subscriptions = new CompositeDisposable(
    lumine.commands.add("lumine-workspace", {
      "jupyter-inspector:toggle-focus": () => toggleFocus(),
      "jupyter-inspector:inspect": () => inspect(),
    }),
    lumine.workspace.addOpener((uri) => (uri === INSPECTOR_URI ? createPane() : undefined)),
    new Disposable(() => destroyPane()),
  );
}

function deactivate() {
  subscriptions?.dispose();
  subscriptions = null;
  session.destroy();
}

function consumeJupyterKernel(jupyterProvider) {
  // The session follows the active kernel and drops a kernel's store when it
  // goes — every method on a wrapper throws once its kernel is gone, so a
  // result left on screen after a shutdown is a reference it must not use.
  session.setProvider(jupyterProvider);

  return new Disposable(() => {
    session.destroy();
    destroyPane();
  });
}

/**
 * jupyter-repl's ANSI colouring and output truncation for the help text.
 * Optional: without it the colour escapes are stripped instead of drawn.
 */
function consumeJupyterOutput(service) {
  const outputRenderer = require("./output-renderer");
  outputRenderer.set(service);
  return new Disposable(() => outputRenderer.set(null));
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
  return new InspectorPane(session, (editor) => watchEditor?.(editor));
}

function destroyPane() {
  lumine.workspace
    .getPaneItems()
    .find((item) => item.getURI?.() === INSPECTOR_URI)
    ?.destroy();
}

/**
 * Inspect whatever the cursor is on. The expression comes from the provider
 * rather than being parsed here, so it is the same one the REPL would run.
 */
async function inspect() {
  if (!session.provider) {
    lumine.notifications.addWarning("jupyter-inspector", {
      description: "Waiting for `jupyter-repl` to provide a kernel.",
    });
    return;
  }

  const kernel = session.provider.getActiveKernel();
  if (!kernel) {
    // No store to write an error into; the panel itself says so.
    await show();
    return;
  }

  const expression = session.provider.getExpressionAtCursor();
  if (!expression) {
    session.storeFor(kernel).setError("No code to introspect!");
    await show();
    return;
  }

  session.storeFor(kernel).loadExpression(expression);
  await show();
}

// Open without stealing focus: the cursor is still where the user is reading.
async function show() {
  await lumine.workspace.open(INSPECTOR_URI, { searchAllPanes: true, activatePane: false });
  // activatePane: false also skips revealing a collapsed dock, and a result
  // rendered into a hidden panel looks like the command did nothing.
  lumine.workspace.paneContainerForURI(INSPECTOR_URI)?.show?.();
}

async function toggleFocus() {
  const pane = lumine.workspace.paneForURI(INSPECTOR_URI);
  const element = pane?.element;
  const isFocused =
    element &&
    (element.offsetWidth !== 0 || element.offsetHeight !== 0) &&
    element.contains(document.activeElement);

  if (isFocused) {
    lumine.workspace.getCenter().activate();
    return;
  }

  const item = await lumine.workspace.open(INSPECTOR_URI, { searchAllPanes: true });
  item?.focus?.();
}

module.exports = {
  activate,
  deactivate,
  consumeJupyterKernel,
  consumeJupyterOutput,
  consumeAutocompleteWatchEditor,
  INSPECTOR_URI,
};
