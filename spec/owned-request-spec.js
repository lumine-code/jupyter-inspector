const { InspectorStore } = require("../lib/inspector-store");
const { recordRequest, generationKernel, settle } = require("./request-fixture");
function kernel() {
  return generationKernel({
    language: "python",
    requests: [],
    executed: [],
    inspectReply: () => new Promise(() => {}),
    request(specification) {
      return recordRequest(this, specification);
    },
  });
}

function queuedKernel() {
  const source = kernel();
  source.temporary = false;
  source.cleaned = [];
  source.request = (specification) => {
    const request = recordRequest(source, specification);
    const timer =
      specification.timeoutMs > 0
        ? setTimeout(() => request.finish({ status: "timeout" }), specification.timeoutMs)
        : null;
    const generation = source.onDidChangeGeneration(() => {
      request.dispose();
      source.temporary = false;
    });
    void request.done.finally(() => {
      clearTimeout(timer);
      generation.dispose();
    });
    return request;
  };
  source.finishAcceptedEvaluation = () => {
    const request = source.requests[0];
    if (request.generation !== source.generation) return;
    // Cancelling the UI observation does not cancel code already sent.
    source.temporary = true;
    request.finish();
  };
  source.runQueuedCleanup = () => {
    const cleanup = source.requests[1];
    if (cleanup.disposed || cleanup.generation !== source.generation) return;
    source.cleaned.push(cleanup.code);
    source.temporary = false;
    cleanup.finish();
  };
  return source;
}
describe("owned inspection requests", () => {
  it("disposes the old inspection when a new expression supersedes it", async () => {
    const source = kernel();
    const store = new InspectorStore(source);
    store.loadExpression("previous");
    store.loadExpression("current");
    expect(source.requests[0].disposed).toBe(true);
    source.requests[1].finish({
      data: { found: true, data: { "text/plain": "current documentation" } },
    });
    await settle();
    expect(store.text).toBe("current documentation");
    store.destroy();
  });
  it("reports transport unavailability separately from missing documentation", async () => {
    const source = kernel();
    const store = new InspectorStore(source);
    store.loadExpression("value");
    source.requests[0].finish({
      status: "unavailable",
      error: { evalue: "Transport unavailable" },
    });
    await settle();
    expect(store.error).toBe("Transport unavailable");
    expect(store.loading).toBe(false);
    store.destroy();
  });
  it("does not send a temporary cleanup into the replacement kernel generation", async () => {
    const source = kernel();
    const store = new InspectorStore(source);
    store.loadExpression("make()");
    source.advanceGeneration();
    await settle();
    expect(source.requests[0].disposed).toBe(true);
    expect(source.executed.length).toBe(1);
    expect(store.text).toBeNull();
    expect(store.loading).toBe(false);
    store.destroy();
  });

  it("keeps cleanup queued after a closed panel's accepted evaluation outlives ten seconds", async () => {
    const source = queuedKernel();
    const store = new InspectorStore(source);
    store.loadExpression("slow_large_result()");
    store.destroy();
    await settle();
    const cleanup = source.requests[1];
    let settled = false;
    cleanup.done.then(() => {
      settled = true;
    });
    window.advanceClock(15000);
    await settle();
    expect(settled).toBe(false);
    expect(cleanup.specification.collectOutputs).toBe(false);
    source.finishAcceptedEvaluation();
    expect(source.temporary).toBe(true);
    source.runQueuedCleanup();
    await settle();
    expect(source.temporary).toBe(false);
    expect(source.cleaned.length).toBe(1);
    expect(source.cleaned[0]).toMatch(/^globals\(\)\.pop\("__jupyter_inspector_result_/);
    expect((await cleanup.done).status).toBe("ok");
  });

  it("retires a queued cleanup with its original Session instead of clearing a replacement namespace", async () => {
    const source = queuedKernel();
    const store = new InspectorStore(source);
    store.loadExpression("slow_large_result()");
    store.destroy();
    await settle();
    const cleanup = source.requests[1];
    source.advanceGeneration();
    await settle();
    expect(cleanup.disposed).toBe(true);
    source.temporary = true; // A value belonging to the replacement namespace.
    window.advanceClock(15000);
    source.finishAcceptedEvaluation();
    source.runQueuedCleanup();
    expect(source.temporary).toBe(true);
    expect(source.cleaned).toEqual([]);
    expect(source.requests.length).toBe(2);
  });
});
