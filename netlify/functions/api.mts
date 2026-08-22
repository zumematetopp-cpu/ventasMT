export default async (req: Request) => {
  const scriptUrl = Netlify.env.get("APPS_SCRIPT_URL");
  const token = Netlify.env.get("APPS_SCRIPT_TOKEN");
  if (!scriptUrl || !token) return Response.json({ ok: false, error: "Backend no configurado" }, { status: 500 });
  const allowedGet = new Set(["health", "seller", "orders"]);
  const allowedPost = new Set(["upsertSeller", "setB2B", "createOrder", "registerPayment"]);
  try {
    if (req.method === "GET") {
      const incoming = new URL(req.url);
      const action = incoming.searchParams.get("action") || "";
      if (!allowedGet.has(action)) return Response.json({ ok: false, error: "Acción no permitida" }, { status: 400 });
      const target = new URL(scriptUrl);
      incoming.searchParams.forEach((value, key) => target.searchParams.set(key, value));
      target.searchParams.set("token", token);
      const response = await fetch(target, { redirect: "follow" });
      const text = await response.text();
      return new Response(text, { status: response.ok ? 200 : response.status, headers: { "content-type": "application/json; charset=utf-8" } });
    }
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (!allowedPost.has(body.action)) return Response.json({ ok: false, error: "Acción no permitida" }, { status: 400 });
      const response = await fetch(scriptUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, token }), redirect: "follow" });
      const text = await response.text();
      return new Response(text, { status: response.ok ? 200 : response.status, headers: { "content-type": "application/json; charset=utf-8" } });
    }
    return Response.json({ ok: false, error: "Método no permitido" }, { status: 405 });
  } catch (error) {
    return Response.json({ ok: false, error: String(error) }, { status: 500 });
  }
};
export const config = { path: "/api" };
