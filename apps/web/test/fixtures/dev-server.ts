export default {
  async fetch(request: Request) {
    if (new URL(request.url).pathname === "/read-body") await request.text();

    return new Response("fixture ready");
  },
};
