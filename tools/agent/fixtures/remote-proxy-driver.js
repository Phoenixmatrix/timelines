export default {
  async fetch(request, env) {
    const command = await request.json();
    const checkpoint = (phase, result) =>
      env.CONTROL.fetch("http://control/checkpoint", {
        method: "POST",
        body: JSON.stringify({ phase, result }),
      });
    let result;
    let repo;
    let blob;
    try {
      if (command.method === "repo") {
        repo = await env.ARTIFACTS.get("fixture");
        const first = await repo.info();
        await checkpoint("held", first);
        const second = await repo.info();
        blob = await repo.readFile({ ref: "main", path: "file.txt" });
        result = { first, second };
      } else if (["createToken", "revokeToken", "fork"].includes(command.method)) {
        repo = await env.ARTIFACTS.get("fixture");
        result = await repo[command.method]("fixture-argument");
      } else {
        result = await env.ARTIFACTS[command.method]("fixture");
      }
    } catch (error) {
      result = { error: String(error.message ?? error) };
    } finally {
      repo?.[Symbol.dispose]();
    }
    if (blob) result.blob = await blob.text();
    // Keep this invocation alive while Node inspects sockets: returning the HTTP
    // response must not be the thing that releases the remote proxy session.
    await checkpoint("settled", result ?? null);
    return Response.json(result ?? null);
  },
};
