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
});
