const { CompositeDisposable, Disposable } = require("lumine");
const InspectorSession = require("./inspector-session");
const etch = require("@lumine-code/etch");

// Etch holds its scheduler per copy of the library, and this package resolves
// its own copy — so the assignment the editor makes on core's copy never
// reaches it. Point it at the view registry before anything renders, or this
// package's DOM writes land on an animation frame of their own alongside the
// editor's and force a synchronous reflow.
etch.setScheduler(lumine.views);

const INSPECTOR_URI = "lumine://jupyter-inspector";

let subscriptions = null;
let watchEditor = null;
let session = null;
let pane;

// Window restoration reaches deserializers before package activation. Build
// the one session they and all later services share in the earlier hook.
function initialize() {
  session ??= new InspectorSession();
  pane ??= null;
}

function activate() {
  initialize();
  subscriptions = new CompositeDisposable(
    lumine.commands.add("lumine-workspace", {
      "jupyter-inspector:toggle-focus": () => toggleFocus(),
      "jupyter-inspector:inspect": {
        description: "Look up what the kernel knows about the expression at the cursor.",
        didDispatch: () => inspect(),
      },
    }),
    lumine.workspace.addOpener((uri) => (uri === INSPECTOR_URI ? getInspectorPane() : undefined)),
    new Disposable(() => destroyPane()),
  );
}

function deactivate() {
  subscriptions?.dispose();
  subscriptions = null;
  destroyPane();
  session?.destroy();
}

function consumeJupyterKernel(jupyterProvider) {
  initialize();
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

function getInspectorPane() {
  initialize();
  if (!pane) {
    const InspectorPane = require("./inspector-pane");
    const created = new InspectorPane(session, (editor) => watchEditor?.(editor));
    created.onDidDestroy(() => {
      if (pane === created) {
        pane = null;
      }
    });
    pane = created;
  }
  return pane;
}

function destroyPane() {
  pane?.destroy();
  pane = null;
}

function deserializeInspectorPane() {
  return getInspectorPane();
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
  initialize,
  activate,
  deactivate,
  deserializeInspectorPane,
  consumeJupyterKernel,
  consumeJupyterOutput,
  consumeAutocompleteWatchEditor,
  INSPECTOR_URI,
};
