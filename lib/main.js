const { CompositeDisposable, Disposable } = require("lumine");
const InspectorSession = require("./inspector-session");
const { autocompleteConsumer } = require("./autocomplete");

const INSPECTOR_URI = "lumine://jupyter-inspector";

let subscriptions = null;
let lifecycleGeneration = 0;
let context = null;
let connections = createConnections();
let session = null;
let pane;

function initialPackageBatchPending() {
  const packages = lumine.packages;
  return Boolean(
    packages?.activatePromise ||
    (packages?.hasLoadedInitialPackages?.() && !packages?.hasActivatedInitialPackages?.()),
  );
}

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
    }),
    lumine.commands.add("lumine-text-editor:not([mini])", {
      "jupyter-inspector:inspect": {
        description: "Look up what the kernel knows about the expression at the cursor.",
        didDispatch: (event) => inspect(event),
      },
    }),
    lumine.workspace.addOpener((uri) => (uri === INSPECTOR_URI ? getInspectorPane() : undefined)),
    new Disposable(() => destroyPane()),
  );
}

function deactivate() {
  lifecycleGeneration++;
  subscriptions?.dispose();
  subscriptions = null;
  context = null;
  for (const state of Object.values(connections)) {
    for (const edge of state.edges) edge.payload = null;
    state.edges.clear();
  }
  connections = createConnections();
  destroyPane();
  session?.destroy();
  session = null;
  autocompleteConsumer.revoke();
  require("./output-renderer").set(null);
}

function createConnections() {
  return Object.fromEntries(
    ["context", "kernel", "output"].map((kind) => [kind, { edges: new Set(), revision: 0 }]),
  );
}

function consumeConnection(kind, payload, apply) {
  const state = connections[kind];
  const edge = { payload };
  state.edges.add(edge);
  const refresh = () => {
    if (connections[kind] !== state) return;
    const revision = ++state.revision;
    const current = () => connections[kind] === state && state.revision === revision;
    apply(Array.from(state.edges).at(-1)?.payload ?? null, current);
  };
  refresh();
  return new Disposable(() => {
    state.edges.delete(edge);
    edge.payload = null;
    refresh();
  });
}

function consumeJupyterContext(service) {
  return consumeConnection("context", service, (next) => {
    context = next;
  });
}

function consumeJupyterKernel(provider) {
  initialize();
  const connectedSession = session;
  return consumeConnection("kernel", provider, (next, current) => {
    const connect = () => {
      if (!current() || session !== connectedSession) return;
      connectedSession.setProvider(next);
      if (!next) destroyPane();
    };
    if (next && initialPackageBatchPending()) queueMicrotask(connect);
    else connect();
  });
}

function consumeJupyterOutput(service) {
  const renderer = require("./output-renderer");
  return consumeConnection("output", service, (next) => {
    if (renderer.get() !== next) renderer.set(next);
  });
}

function consumeAutocompleteWatchEditor(service) {
  return autocompleteConsumer.consume(service);
}

function getInspectorPane() {
  initialize();
  if (!pane) {
    require("@lumine-code/etch").setScheduler(lumine.views);
    const InspectorPane = require("./inspector-pane");
    const created = new InspectorPane(session, (editor) =>
      autocompleteConsumer.watchPanelEditor(editor),
    );
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
async function inspect(event) {
  if (!session.provider) {
    lumine.notifications.addWarning("jupyter-inspector", {
      description: "Waiting for `jupyter-repl` to provide a kernel.",
    });
    return;
  }

  const editor = lumine.workspace.getTextEditorForElement(event?.target, { includeMini: false });
  if (!editor) return;
  const kernel = session.provider.getKernelForEditor(editor);
  if (!kernel) {
    // No store to write an error into; the panel itself says so.
    await show();
    return;
  }

  session.setKernel(kernel);
  const expression = context?.getExpressionAtCursor(editor) || "";
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
  const generation = lifecycleGeneration;
  await lumine.workspace.open(INSPECTOR_URI, { searchAllPanes: true, activatePane: false });
  if (generation !== lifecycleGeneration) return;
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
  provideBackgroundTips() {
    return {
      packageName: "jupyter-inspector",
      tips: [
        "You can look up the documentation for whatever is under the cursor with {{ 'jupyter-inspector:inspect' | keystroke }}",
      ],
    };
  },

  initialize,
  activate,
  deactivate,
  deserializeInspectorPane,
  consumeJupyterKernel,
  consumeJupyterContext,
  consumeJupyterOutput,
  consumeAutocompleteWatchEditor,
  INSPECTOR_URI,
};
