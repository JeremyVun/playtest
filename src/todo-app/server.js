// Dummy's test subject: a zero-dependency todo app. It is a fixture, not a product.
import http from "node:http";
import { pathToFileURL } from "node:url";

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

// UI-variant mutation hook (built for the self-test and demo act three):
// variant "b" renames the add button's data-testid (and label), so a saved
// path recorded against the default UI misses its locator and the harness
// must heal. The label "Save" stays recognizable as a submit button to
// humans and agents alike.
function pageHtml(variant) {
  const addButton = variant === "b"
    ? '<button type="submit" data-testid="submit-button">Save</button>'
    : '<button type="submit" data-testid="add-button">Add</button>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Todos</title>
<link rel="icon" href="data:,">
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background: linear-gradient(180deg, #f7f4ee, #ece7dd);
    color: #2b2926;
    display: flex; justify-content: center;
    padding: 48px 16px;
  }
  main { width: 100%; max-width: 460px; }
  h1 { margin: 0 0 16px; font-size: 1.9rem; letter-spacing: -0.02em; }
  .card { background: #fff; border-radius: 12px; box-shadow: 0 2px 10px rgba(43,41,38,.08); }
  form { display: flex; flex-wrap: wrap; gap: 8px 10px; padding: 14px; }
  form label { flex-basis: 100%; font-size: .85rem; font-weight: 600; color: #6b665e; }
  #new-todo { flex: 1; min-width: 0; font: inherit; padding: 9px 12px; border: 1px solid #d8d2c8; border-radius: 8px; }
  #new-todo:focus { outline: 2px solid #4a6b50; outline-offset: 1px; }
  button { font: inherit; cursor: pointer; }
  form button { padding: 9px 18px; border: none; border-radius: 8px; background: #4a6b50; color: #fff; font-weight: 600; }
  ul { list-style: none; margin: 16px 0; padding: 4px 0; }
  ul:empty { display: none; }
  li { display: flex; align-items: center; gap: 10px; padding: 10px 14px; }
  li + li { border-top: 1px solid #f0ece4; }
  li input[type=checkbox] { width: 18px; height: 18px; accent-color: #4a6b50; }
  li label { flex: 1; }
  li.done label { text-decoration: line-through; color: #a39d92; }
  .delete { border: none; background: none; color: #b0564a; font-size: 1.2rem; line-height: 1; padding: 2px 7px; border-radius: 6px; }
  .delete:hover { background: #f7e8e6; }
  footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 14px; font-size: .85rem; color: #6b665e; flex-wrap: wrap; }
  nav { display: flex; gap: 6px; }
  nav a { color: inherit; text-decoration: none; padding: 3px 9px; border-radius: 6px; border: 1px solid transparent; }
  nav a[aria-current=page] { border-color: #c9c2b6; background: #fff; }
  #clear-completed { border: none; background: none; color: #6b665e; text-decoration: underline; padding: 3px; }
</style>
</head>
<body>
<main>
  <h1>Todos</h1>
  <form id="add-form" class="card">
    <label for="new-todo">What needs doing?</label>
    <input id="new-todo" data-testid="todo-input" type="text" autocomplete="off">
    ${addButton}
  </form>
  <ul id="todo-list" data-testid="todo-list" class="card"></ul>
  <footer>
    <p id="todo-count" data-testid="todo-count" aria-live="polite">0 items left</p>
    <nav aria-label="Filter todos">
      <a href="#all" data-filter="all" aria-current="page">All</a>
      <a href="#active" data-filter="active">Active</a>
      <a href="#completed" data-filter="completed">Completed</a>
    </nav>
    <button type="button" id="clear-completed" data-testid="clear-completed">Clear completed</button>
  </footer>
</main>
<script>
  var list = document.getElementById("todo-list");
  var input = document.getElementById("new-todo");
  var count = document.getElementById("todo-count");
  var todos = [];
  var filter = "all";

  async function api(method, path, body) {
    var res = await fetch(path, {
      method: method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(method + " " + path + " -> " + res.status);
    return res.json();
  }

  async function load() {
    todos = await api("GET", "/api/todos");
    render();
  }

  function render() {
    var visible = todos.filter(function (t) {
      if (filter === "active") return !t.completed;
      if (filter === "completed") return t.completed;
      return true;
    });
    list.replaceChildren();
    for (var t of visible) list.append(renderItem(t));
    var left = todos.filter(function (t) { return !t.completed; }).length;
    count.textContent = left + (left === 1 ? " item left" : " items left");
  }

  function renderItem(t) {
    var li = document.createElement("li");
    li.dataset.testid = "todo-item";
    if (t.completed) li.classList.add("done");

    var box = document.createElement("input");
    box.type = "checkbox";
    box.id = "todo-" + t.id;
    box.checked = t.completed;
    box.addEventListener("change", async function () {
      await api("PATCH", "/api/todos/" + t.id, { completed: box.checked });
      await load();
    });

    var label = document.createElement("label");
    label.htmlFor = box.id;
    label.textContent = t.title;

    var del = document.createElement("button");
    del.type = "button";
    del.className = "delete";
    del.setAttribute("aria-label", "Delete " + t.title);
    del.textContent = "\\u00d7";
    del.addEventListener("click", async function () {
      await api("DELETE", "/api/todos/" + t.id);
      await load();
    });

    li.append(box, label, del);
    return li;
  }

  document.getElementById("add-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var title = input.value.trim();
    if (!title) return;
    input.value = "";
    await api("POST", "/api/todos", { title: title });
    await load();
  });

  document.getElementById("clear-completed").addEventListener("click", async function () {
    await api("DELETE", "/api/todos?completed=true");
    await load();
  });

  for (var link of document.querySelectorAll("[data-filter]")) {
    link.addEventListener("click", function (e) {
      e.preventDefault();
      filter = e.currentTarget.dataset.filter;
      for (var l of document.querySelectorAll("[data-filter]")) {
        if (l.dataset.filter === filter) l.setAttribute("aria-current", "page");
        else l.removeAttribute("aria-current");
      }
      render();
    });
  }

  load();
</script>
</body>
</html>
`;
}

/**
 * Boot one todo-app instance. State (todos, ids) is per-instance: two
 * concurrent starts never share anything.
 * @param {{ port?: number, variant?: string|null }} [opts] port 0 = ephemeral
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export async function start({ port = 0, variant = null } = {}) {
  let todos = [];
  let nextId = 1;
  const page = pageHtml(variant);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page);
        return;
      }

      if (url.pathname === "/api/todos") {
        if (req.method === "GET") return json(res, 200, todos);
        if (req.method === "POST") {
          const body = await readBody(req);
          const title = typeof body.title === "string" ? body.title.trim() : "";
          if (!title) return json(res, 400, { error: "title is required" });
          const todo = { id: nextId++, title, completed: false };
          todos.push(todo);
          return json(res, 201, todo);
        }
        if (req.method === "DELETE") {
          if (url.searchParams.get("completed") !== "true") {
            return json(res, 400, { error: "expected ?completed=true" });
          }
          const before = todos.length;
          todos = todos.filter((t) => !t.completed);
          return json(res, 200, { deleted: before - todos.length });
        }
      }

      const idMatch = url.pathname.match(/^\/api\/todos\/(\d+)$/);
      if (idMatch) {
        const todo = todos.find((t) => t.id === Number(idMatch[1]));
        if (!todo) return json(res, 404, { error: "not found" });
        if (req.method === "PATCH") {
          const body = await readBody(req);
          if (typeof body.completed === "boolean") todo.completed = body.completed;
          return json(res, 200, todo);
        }
        if (req.method === "DELETE") {
          todos = todos.filter((t) => t !== todo);
          return json(res, 200, { deleted: 1 });
        }
      }

      if (req.method === "POST" && url.pathname === "/api/reset") {
        todos = [];
        nextId = 1;
        return json(res, 200, { ok: true });
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, resolve);
  });
  const boundPort = server.address().port;
  return {
    url: `http://localhost:${boundPort}`,
    port: boundPort,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
  };
}

// CLI: `npm run todo-app` / `node src/todo-app/server.js`. Importing this
// module never binds a port.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { port } = await start({
    port: Number(process.env.PORT) || 4173,
    variant: process.env.TODO_APP_VARIANT || null,
  });
  console.log("todo-app listening on http://localhost:" + port);
}
