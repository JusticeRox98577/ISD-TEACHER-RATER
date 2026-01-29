export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return new Response("OK", { status: 200 });
    }

    return new Response("API running");
  }
};
